"""跨 worker／跨實例「單跑者」租約（Postgres advisory lock）。

為什麼需要：notify_monitor 這類**有外部副作用**的背景工作（自動下單、Web Push）在
多 worker（WEB_CONCURRENCY>1）或 Railway 多 replica 下會跑多份 → 重複下單／重複推播。
用 Postgres session 級 advisory lock 保證全局只有一個跑者：
  - 搶到鎖的 process＝跑者；其餘 standby（每輪重試，搶到即接手）。
  - 跑者掛掉／連線斷 → 鎖自動釋放 → standby 下一輪 ensure() 接手（自動故障轉移，無需心跳表）。
  - 本機開發（無 DATABASE_URL）→ 視為單實例，恆為跑者，行為與從前完全相同。

失效語義（重要）：
  - 「曾持鎖」的連線出錯 → 該輪回 False（fail-closed）：此時鎖可能已被別的實例接手，
    寧可跳過一輪（60s 後重試）也不要冒雙跑者風險。
  - 「從未連上」PG（例如 PG 短暫故障）→ 也回 False：此時 accounts/auto-cfg 等讀取
    多半也會失敗，跑了也是空轉；下一輪重試即可。
"""
import os
import threading
import zlib


class SingletonLease:
    def __init__(self, name: str):
        self.name = name
        # advisory lock key：name 的 crc32（正 int32，跨實例一致）
        self.key = zlib.crc32(name.encode("utf-8")) & 0x7FFFFFFF
        self._conn = None
        self._held = False
        self._lock = threading.Lock()

    def ensure(self) -> bool:
        """每輪呼叫一次：確保連線活著並嘗試持鎖。回傳「本 process 目前是不是跑者」。"""
        url = os.getenv("DATABASE_URL")
        if not url:
            return True                                    # 本機／無 PG＝單實例
        with self._lock:
            try:
                if self._conn is None or self._conn.closed:
                    import psycopg
                    self._conn = psycopg.connect(
                        url.replace("postgres://", "postgresql://", 1),
                        connect_timeout=8, autocommit=True)
                    self._held = False
                if self._held:
                    self._conn.execute("SELECT 1")          # 心跳：連線死掉會丟例外 → 下輪重連重搶
                    return True
                cur = self._conn.execute("SELECT pg_try_advisory_lock(%s)", (self.key,))
                self._held = bool(cur.fetchone()[0])
                return self._held
            except Exception as e:
                try:
                    if self._conn is not None:
                        self._conn.close()
                except Exception:
                    pass
                self._conn = None
                self._held = False
                print(f"  ⚠ singleton_lease({self.name}) 連線異常（本輪視為 standby）：{e}")
                return False

    @property
    def held(self) -> bool:
        return self._held or not os.getenv("DATABASE_URL")
