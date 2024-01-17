const express = require('express');
const mongo = require('./Database/db');
const app = express();

const PORT = process.env.PORT || 300;


app.listen(PORT, ()=>{
    console.log(`Listening to PORT : ${PORT}`)
})
