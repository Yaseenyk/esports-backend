const mongoose = require("mongoose");
require('dotenv').config();


const url = process.env.MONGO_URL;

  mongoose.connect(url);

  const db = mongoose.connection;

  db.on("connected", () => {
    console.log("DB Connected");
  });

