require("dotenv").config();
const { GoogleAuth } = require("google-auth-library");
const uploadImageToStorage = require("./upload"); // Existing storage upload utility

const saKeyPath = "/etc/secrets/mogibaai-storage-key.json"; // Render secret absolute path
const projectId = process.env.GOOGLE_PROJECT_ID;

const MODEL_ID = "imagen-4.0-fast-generate-preview-06-06"; // FAST MODEL

async function generateFastImage({ prompt, size = "1024x1024", userId = "public" }) {
  if (!prompt) throw new Error("Prompt is required");

  // Supported aspect ratios for Google Imagen 4 Fast
  const aspectRatioMap = {
    "1024x1024": "1:1",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
    "576x1024": "9:16",
    "1024x576": "16:9"
  };
  if (!aspectRatioMap[size]) throw new Error("Selected size not supported for Imagen 4 Fast");

  const auth = new GoogleAuth({
    keyFilename: saKeyPath,
    scopes: "https://www.googleapis.com/auth/cloud-platform"
  });
  const client = await auth.getClient();

  const predictUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/${MODEL_ID}:predict`;

  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: aspectRatioMap[size]
    }
  };

  const response = await client.request({ url: predictUrl, method: "POST", data: body });

  // Checks
  if (
    !response.data.predictions ||
    !Array.isArray(response.data.predictions) ||
    !response.data.predictions[0] ||
    !response.data.predictions[0].bytesBase64Encoded
  ) {
    throw new Error("Image generation failed (no predictions found)");
  }

  // Upload to storage (optional)
  const imageBase64 = response.data.predictions[0].bytesBase64Encoded;
  const buffer = Buffer.from(imageBase64, "base64");
  const filename = `users/${userId}/img_${Date.now()}.jpg`;
  const publicUrl = await uploadImageToStorage(buffer, filename, "image/jpeg");

  return { imageUrl: publicUrl };
}

module.exports = generateFastImage;
