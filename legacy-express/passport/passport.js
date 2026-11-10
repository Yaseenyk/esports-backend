const passport = require('passport');
const LocalStrategy = require('passport-local').Stratergy;
const User = require('../model/UserSchema');


passport.use(
    new LocalStrategy(async(username,password,done)=>{
        try{
            const user = await User.findOne({username});

            if(!user){
                return done(null,false,{message:'Incorrect Username'})
            }

            const isMatch = await bycrypt.compare(password,user.password);

            if(isMatch){
                return done(null,user);
            }else{
                return done(null,false,{message:'Incorrect Password'})
            }
        }catch(err){
            return done(err)
        }
    })
);

passport.serializeUser((user,done)=>{
    done(null,user.id);
});

passport.deserializeUser(async (id,done)=>{
    try{
        const user = await User.findById(id);
        done(null,user);
    }catch(err){
        done(err)
    }
})