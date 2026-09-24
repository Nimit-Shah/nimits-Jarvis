from fastapi import FastAPI
import uvicorn

app = FastAPI(title="Laya Sidecar")

@app.get("/health")
def health():
    return {"status": "ok"}

# Add your Laya-MLX judgment endpoints here
