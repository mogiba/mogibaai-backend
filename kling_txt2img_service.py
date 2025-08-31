from flask import Flask, request, jsonify
import os
import requests
from dotenv import load_dotenv
import time
import jwt  # if JWT required for token generation (otherwise remove)

load_dotenv()  # Load .env file

app = Flask(__name__)

# Load environment variables
KLING_ACCESS_KEY = os.getenv("KLING_ACCESS_KEY")
KLING_SECRET_KEY = os.getenv("KLING_SECRET_KEY")
KLING_API_BASE = "https://api-singapore.klingai.com/v1"

def generate_kling_jwt():
    # JWT generation example (modify according to Kling API docs)
    import time
    import jwt
    payload = {
        "iss": KLING_ACCESS_KEY,
        "exp": int(time.time()) + 3600,
    }
    token = jwt.encode(payload, KLING_SECRET_KEY, algorithm="HS256")
    return token

@app.route('/kling-txt2img', methods=['POST'])
def generate_image():
    data = request.json
    prompt = data.get("prompt")
    negative_prompt = data.get("negative_prompt", "")
    resolution = data.get("resolution", "2k")
    n = data.get("n", 2)
    aspect_ratio = data.get("aspect_ratio", "16:9")

    if not prompt:
        return jsonify({"error": "Prompt is required"}), 400

    jwt_token = generate_kling_jwt()

    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "Content-Type": "application/json",
    }

    body = {
        "model_name": "kling-v2",
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "resolution": resolution,
        "n": n,
        "aspect_ratio": aspect_ratio,
    }

    try:
        # Step 1: Start generation
        generation_res = requests.post(f"{KLING_API_BASE}/images/generations", json=body, headers=headers)
        generation_res.raise_for_status()
        gen_data = generation_res.json()

        task_id = gen_data.get("data", {}).get("task_id") or gen_data.get("task_id")
        if not task_id:
            return jsonify({"error": "No task_id from Kling", "raw": gen_data}), 500

        # Step 2: Poll for result
        max_tries = 60
        tries = 0
        while tries < max_tries:
            time.sleep(6)  # wait 6 seconds
            poll_res = requests.get(f"{KLING_API_BASE}/images/generations/{task_id}", headers=headers)
            poll_res.raise_for_status()
            poll_data = poll_res.json()
            status = poll_data.get("data", {}).get("task_status") or poll_data.get("status")
            images = poll_data.get("data", {}).get("task_result", {}).get("images") or poll_data.get("images")
            if status == "succeeded" and images:
                urls = [img["url"] for img in images]
                return jsonify({"imageUrl": urls, "status": "succeeded"})
            if status == "failed":
                return jsonify({"error": "Kling API generation failed", "raw": poll_data}), 500
            tries += 1

        return jsonify({"error": "Timed out waiting for Kling image generation"}), 504

    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host="0.0.0.0", port=4001, debug=False)
