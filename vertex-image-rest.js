// server/vertex-image-rest.js

require('dotenv').config();
const { GoogleAuth } = require('google-auth-library');
const axios        = require('axios');
const fs           = require('fs');
const path         = require('path');

async function generateImage(promptText) {
  // explicitly load your service key (ensures GOOGLE_APPLICATION_CREDENTIALS is used)
  const auth = new GoogleAuth({
    keyFilename: path.join(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS),
    scopes:      'https://www.googleapis.com/auth/cloud-platform',
  });

  // get an authenticated HTTP client
  const client = await auth.getClient();

  // build your endpoint URL
  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/` +
              `${process.env.GOOGLE_PROJECT_ID}/locations/us-central1/` +
              `publishers/google/models/imagen-4.0-generate-preview-06-06:predict`;

  // prepare request payload
  const body = {
    instances:  [{ prompt: promptText }],
    parameters: { sampleCount: 1 },
  };

  // call the REST API
  const res = await client.request({
    url,
    method: 'POST',
    data: body,
  });

  // pull out the base64 PNG bytes
  const b64 = res.data.predictions[0].bytesBase64Encoded;

  // write a PNG file
  fs.writeFileSync(path.join(__dirname, 'out.png'), b64, 'base64');
  console.log('✅  Image written to out.png');
}

// run it with any prompt you like
generateImage("A hyper-realistic photo of a cute puppy astronaut").catch(console.error);
