from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os
import time
import jwt
from dotenv import load_dotenv

# Load .env keys
load_dotenv()
KLING_API_KEY = os.getenv("KLING_API_KEY")
KLING_API_SECRET = os.getenv("KLING_API_SECRET")

app = FastAPI()

# CORS allow all origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/kling-jwt")
def get_jwt():
    if not KLING_API_KEY or not KLING_API_SECRET:
        return {"error": "Missing API key or secret"}

    now = int(time.time())
    payload = {
        "iss": KLING_API_KEY,
        "exp": now + 1800,  # 30 mins
        "nbf": now - 5       # start 5 secs ago
    }

    headers = {
        "alg": "HS256",
        "typ": "JWT"
    }

    token = jwt.encode(payload, KLING_API_SECRET, algorithm="HS256", headers=headers)
    return {"token": token}
