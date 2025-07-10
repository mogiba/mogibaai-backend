require('dotenv').config();
const {VertexAI} = require('@google-cloud/vertexai');
const fs = require('fs');

// 1. **.json file path** (downloaded key, same folder unte just name pettu)
const keyFile = './aqueous-cargo-464304-g6-9f6c0efdd7b0.json'; // <<< ikkadiki meeku download aina .json file name exact ga pettandi

// 2. **Project ID** (from Google Cloud)
const PROJECT_ID = 'aqueous-cargo-464304-g6';

// 3. Model/version (this is correct, don't change)
const PUBLISHER = 'google';
const MODEL = 'imagen-4.0-generate-preview-06-06'; // latest as per docs

const vertexAI = new VertexAI({
  project: PROJECT_ID,
  location: 'us-central1',
  keyFile: keyFile,
});

async function generateImage() {
  // Important: Pass "model" exactly like this:
  const modelInstance = vertexAI.preview.getGenerativeModel({
    model: `publishers/${PUBLISHER}/models/${MODEL}`,
  });

  const req = {
    instances: [{ prompt: 'A hyper realistic photo of a cute puppy astronaut' }],
    parameters: { sampleCount: 1 }
  };

  const result = await modelInstance.generateContent(req);
  const imgBase64 = result[0].predictions[0].bytesBase64Encoded;
  fs.writeFileSync('vertex_output.png', imgBase64, 'base64');
  console.log('Image saved as vertex_output.png');
}

generateImage().catch(console.error);
