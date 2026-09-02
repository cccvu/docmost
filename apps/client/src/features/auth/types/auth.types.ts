export interface ILogin {
  email: string;
  password: string;
}

export interface IRegister {
  name?: string;
  email: string;
  password: string;
}

export interface ISetupWorkspace {
  workspaceName?: string;
  name: string;
  email: string;
  password: string;
}

export interface ICollabToken {
  token?: string;
}

export interface ILoginResponse {
  userHasMfa?: boolean;
  requiresMfaSetup?: boolean;
  mfaToken?: string;
  isMfaEnforced?: boolean;
}
