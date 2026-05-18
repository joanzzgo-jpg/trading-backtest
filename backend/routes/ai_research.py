"""AI 策略研究 API：暴力枚舉指標組合，找可獲利配方"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional

from research.ai_strategy import run_research, ATOM_KEYS, ATOM_LABELS
from utils.cache import cache

router = APIRouter(prefix="/api", tags=["ai_research"])


class TargetSpec(BaseModel):
    market: str
    symbol: str
    timeframe: str
    exchange: str = "pionex"


class AIResearchRequest(BaseModel):
    targets: list[TargetSpec]
    days: int = 0
    min_trades: int = Field(10, ge=2, le=500)
    stop_buffer_pct: float = Field(0.0, ge=0.0, le=0.1)
    sizes: list[int] = Field(default_factory=lambda: [2, 3, 4])
    top_n: int = Field(30, ge=1, le=200)
    sort_by: str = "score"  # score | win_rate | ci_low | expectancy | profit_factor | total
    finmind_token: str = ""
    max_hold: int = Field(-1, ge=-1, le=500)  # -1=TF 預設、0=不限
    train_split: float = Field(0.7, ge=0.3, le=0.9)
    robust_only: bool = False
    workers: int = Field(4, ge=1, le=8)


@router.post("/ai_research")
def ai_research(req: AIResearchRequest):
    if not req.targets:
        raise HTTPException(400, "targets 不能為空")
    if len(req.targets) > 12:
        raise HTTPException(400, "一次最多 12 個 (symbol×timeframe)，避免逾時")

    # 排除無效 size
    sizes = tuple(sorted(set(s for s in req.sizes if 2 <= s <= 5))) or (2, 3, 4)

    tkey = "|".join(f"{t.market}/{t.symbol}/{t.timeframe}/{t.exchange}" for t in req.targets)
    cache_key = (
        f"airesearch2:{tkey}:d{req.days}:m{req.min_trades}:b{req.stop_buffer_pct:.4f}"
        f":s{'-'.join(map(str, sizes))}:n{req.top_n}:o{req.sort_by}"
        f":h{req.max_hold}:tr{req.train_split:.2f}:r{int(req.robust_only)}"
    )
    cached = cache.get(cache_key, ttl=1800)
    if cached:
        return cached

    try:
        out = run_research(
            targets=[t.dict() for t in req.targets],
            days=req.days,
            min_trades=req.min_trades,
            stop_buffer_pct=req.stop_buffer_pct,
            sizes=sizes,
            top_n=req.top_n,
            sort_by=req.sort_by,
            finmind_token=req.finmind_token,
            max_hold=req.max_hold,
            train_split=req.train_split,
            robust_only=req.robust_only,
            max_workers=req.workers,
        )
    except Exception as e:
        raise HTTPException(400, str(e))

    # 附上 atom metadata 給前端顯示
    out["atom_labels"] = ATOM_LABELS
    cache.set(cache_key, out)
    return out


@router.get("/ai_research/atoms")
def ai_research_atoms():
    """前端取得所有指標原子的 label，方便顯示"""
    return {
        "keys": ATOM_KEYS,
        "labels": ATOM_LABELS,
        "directions": {"short": "空", "long": "多"},
    }
