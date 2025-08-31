const axios = require('axios');

// Step 1: REQUIRED DATA
const endpoint = "https://api-singapore.klingai.com/v1/images/generations"; // Postman లో వాడింది
const token = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJBeU1kVHBydHJnNEZNUUdRTWRUOXBuOXJoRmhwZTQzbiIsImV4cCI6MTc1MzA5MTgwOSwibmJmIjoxNzUzMDkwMDA0fQ.v8wNzLZyDwFC4qmcitPF-nJVcdltQ9WXl_tygX3veKY"; // Postman లో వాడిన FULL token paste చేయాలి

const body = {
  model_name: "kling-v2",
  prompt: "Potret close-up seorang wanita muda dengan rambut panjang bergelombang warna cokelat keemasan yang mengkilap...",
  negative_prompt: "",
  resolution: "2k",
  n: 2,
  aspect_ratio: "16:9"
};

// Step 2: AXIOS POST CALL
axios.post(endpoint, body, {
  headers: {
    "Content-Type": "application/json",
    "Authorization": token,
  }
})
.then(response => {
  console.log("Success:");
  console.log(response.data);
})
.catch(error => {
  console.log("ERROR:");
  if (error.response) {
    console.log(error.response.status);
    console.log(error.response.data);
  } else {
    console.log(error.message);
  }
});
