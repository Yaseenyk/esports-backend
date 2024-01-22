const express = require('express');
const mongo = require('./Database/db');
const session = require('express-session');
const passport = require('passport');
const authRoutes = require('./routes/userRoutes');
const User = require('./model/UserSchema');
const cors = require('cors');
//Defining Express
const app = express();
const PORT = process.env.PORT || 300;
app.use(cors());

//defining middleware
app.use(express.json());
app.use(express.urlencoded({extended:true}));

//defining Session
app.use(
    session({
        secret:'Yaseen&*6@',
        resave:false,
        saveUninitialized:false
    })
)
app.use(passport.initialize());
app.use(passport.session());
app.use(cors());
//defining routes
app.use('/auth',authRoutes)

//Listening to Port
app.listen(PORT, ()=>{
    console.log(`Listening to PORT : ${PORT}`)
})
