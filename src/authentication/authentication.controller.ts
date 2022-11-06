import bcrypt from "bcrypt";
import { Router, Request, Response, NextFunction } from "express";
import UserWithThatEmailAlreadyExistsException from "../exceptions/UserWithThatEmailAlreadyExistsException";
import WrongCredentialsException from "../exceptions/WrongCredentialsException";
import HttpException from "../exceptions/HttpException";
import IController from "../interfaces/controller.interface";
import validationMiddleware from "../middleware/validation.middleware";
import IUser from "../user/user.interface";
import userModel from "./../user/user.model";
import CreateUserDto from "../user/user.dto";
import LogInDto from "./logIn.dto";
import { OAuth2Client } from "google-auth-library";
import IGoogleUserInfo from "interfaces/googleUserInfo.interface";
import IRequestWithUser from "interfaces/requestWithUser.interface";
import ISession from "./../interfaces/session.interface";

export default class AuthenticationController implements IController {
    public path = "/auth";
    public router = Router();
    private user = userModel;

    constructor() {
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.post(`${this.path}/register`, validationMiddleware(CreateUserDto), this.registration);
        this.router.post(`${this.path}/login`, validationMiddleware(LogInDto), this.login);
        this.router.post(`${this.path}/autologin`, this.autoLogin);
        this.router.post(`${this.path}/logout`, this.logout);
        this.router.post(`${this.path}/google`, this.loginAndRegisterWithGoogle);
    }

    private registration = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const userData: IUser = req.body;
            if (await this.user.findOne({ email: userData.email })) {
                next(new UserWithThatEmailAlreadyExistsException(userData.email));
            } else {
                const hashedPassword = await bcrypt.hash(userData.password, 10);

                const user = await this.user.create({
                    ...userData,
                    password: hashedPassword,
                });
                user.password = undefined;
                req.session.regenerate(error => {
                    if (error) {
                        next(new HttpException(400, error.message)); // to do
                    }
                    console.log("regenerate ok");
                    (req.session as ISession).user_id = user._id as string;
                    (req.session as ISession).user_email = user.email as string;
                    (req.session as ISession).isLoggedIn = true;
                    (req.session as ISession).isAutoLogin = user.auto_login;
                });
                res.send(user);
            }
        } catch (error) {
            next(new HttpException(400, error.message));
        }
    };

    private autoLogin = async (req: IRequestWithUser, res: Response, next: NextFunction) => {
        if (req.session.id && (req.session as ISession).user_id) {
            const user: IUser = await userModel.findById((req.session as ISession).user_id);
            req.sessionStore.get(req.session.id, (error, s: ISession) => {
                if (error || !s.user_email) {
                    next(new HttpException(404, "Please log in!"));
                }
                if (user && s.user_email) {
                    (req.session as ISession).isLoggedIn = true;
                    res.send(user);
                }
            });
        } else {
            next(new HttpException(404, "Please log in!"));
        }
    };

    private login = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const logInData: IUser = req.body;
            const user = await this.user.findOne({ email: logInData.email });
            if (user) {
                const isPasswordMatching = await bcrypt.compare(logInData.password, user.password);
                if (isPasswordMatching) {
                    user.password = undefined;
                    req.session.regenerate(error => {
                        if (error) {
                            next(new HttpException(400, error.message)); // to do
                        }
                        // console.log("regenerate ok");
                        (req.session as ISession).user_id = user._id as string;
                        (req.session as ISession).user_email = user.email;
                        (req.session as ISession).isLoggedIn = true;
                        (req.session as ISession).isAutoLogin = user.auto_login;
                        res.send(user);
                    });
                } else {
                    next(new WrongCredentialsException());
                }
            } else {
                next(new WrongCredentialsException());
            }
        } catch (error: any) {
            next(new HttpException(400, error.message));
        }
    };

    private logout = (req: Request, res: Response) => {
        if (req.session.cookie) {
            // Clear session cookie on client:
            res.cookie("connect.sid", null, {
                httpOnly: true,
                secure: true,
                sameSite: "none",
                maxAge: 1,
            });
            // Delete session document from MongoDB:
            req.session.destroy(err => {
                if (err) {
                    console.log("Error at destroyed session");
                }
                // console.log("Session is destroyed!");
            });
        }
        res.sendStatus(200);
    };

    private loginAndRegisterWithGoogle = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const client: OAuth2Client = new OAuth2Client();
            const verifyToken = async (token: string) => {
                client.setCredentials({ access_token: token });
                const userinfo = await client.request({
                    url: "https://www.googleapis.com/oauth2/v3/userinfo",
                });
                return userinfo.data;
            };

            verifyToken(req.body.atoken)
                .then(userInfo => {
                    const googleUser = userInfo as IGoogleUserInfo;
                    this.user.findOne({ email: googleUser.email }).then(user => {
                        if (user) {
                            req.session.regenerate(error => {
                                if (error) {
                                    next(new HttpException(400, error.message)); // to do
                                }
                                console.log("regenerate ok");
                                (req.session as ISession).user_id = user._id as string;
                                (req.session as ISession).user_email = user.email as string;
                                (req.session as ISession).isLoggedIn = true;
                                (req.session as ISession).isAutoLogin = user.auto_login;
                                res.send(user);
                            });
                        } else {
                            // Register as new Google user
                            this.user
                                .create({
                                    ...googleUser,
                                    password: "stored at Google",
                                    email_address_confirm: googleUser.email,
                                    auto_login: true,
                                    role_bits: 0,
                                })
                                .then(user => {
                                    req.session.regenerate(error => {
                                        if (error) {
                                            next(new HttpException(400, error.message)); // to do
                                        }
                                        (req.session as ISession).user_id = user._id as string;
                                        (req.session as ISession).user_email = user.email as string;
                                        (req.session as ISession).isLoggedIn = true;
                                        (req.session as ISession).isAutoLogin = user.auto_login;
                                        res.send(user);
                                    });
                                });
                        }
                    });
                })
                .catch(() => {
                    next(new WrongCredentialsException());
                });
        } catch (error) {
            next(new HttpException(400, error.message));
        }
    };
}
