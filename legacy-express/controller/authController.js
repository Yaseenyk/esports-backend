// const passport = require('passport');
const jwt = require('jsonwebtoken');
const User = require('../model/UserSchema')
const bcrypt = require('bcrypt')

const generateToken = (token,expiresIn)=>{
    return jwt.sign(token,'Yaseen&*^@',{expiresIn});
}

exports.signup = async (req, res)=>{
try{
        const {username,password,name}= req.body;
        console.log(username,password,name)
        const user = new User({username,password,name});
        const existingUser = await User.findOne({username});
        if(existingUser){
            return res.status(409).json({message:'username is Already Taken'})
        }
        await user.save();
        res.status(200).json({message:'User Created SuccessFully'});
    }catch(err){
        res.status(500).json({message:err.message})
    }
}

exports.login = async (req,res) => {
    try{
        const {username,password} = req.body;
        console.log(req.body)
        //finding user
        const findingUser = await User.findOne({username});
        console.log(findingUser)
        if(!findingUser){
            return res.status(401).json({message:'User Not Found'});
        }
        const isPasswordValid = await bcrypt.compare(password,findingUser.password);
        if(!isPasswordValid){
            return res.status(401).json({message:'Incorrect Password'});
        }

        //generating new tokens
        const accessToken = generateToken({ userId: findingUser._id, username }, '10d');
        const refreshToken = generateToken({ userId: findingUser._id }, '1d');

        //sending back status
        res.status(200).json({ username, accessToken, refreshToken, message: 'Login successful.' });
    }catch(err){
        return res.status(500).json({message:err.message});
    }
}