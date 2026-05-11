"""策略 API 路由"""
from fastapi import APIRouter
from strategies.builtin import BUILTIN_STRATEGIES

router = APIRouter(prefix="/api", tags=["strategies"])


@router.get("/strategies")
def list_strategies():
    """列出所有可用策略"""
    return {
        k: {"name": v["name"], "params": v["params"]}
        for k, v in BUILTIN_STRATEGIES.items()
    }
