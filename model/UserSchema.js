const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const UserSchema = new mongoose.Schema({
    name:{
        type:String,
    },
    username:{
        required: true,
        type:String,
        unique: true
    },
    password:{
        required: true,
        type:String,
    }
})

UserSchema.pre('save',async function(next){
    try{
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(this.password,salt);
        this.password = hashedPassword;
        next();
    }catch(err){
        next(err);
    }
})


const user = mongoose.model('user',UserSchema);

module.exports  = user;