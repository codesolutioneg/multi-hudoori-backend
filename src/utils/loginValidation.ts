const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const LOGIN_MIN_LENGTH = 3;
export const LOGIN_MAX_LENGTH = 255;
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;

export type LoginField = 'login' | 'password';

export type LoginValidationSuccess = {
  ok: true;
  login: string;
  password: string;
};

export type LoginValidationFailure = {
  ok: false;
  message: string;
  field: LoginField;
  code: string;
};

export type LoginValidationResult = LoginValidationSuccess | LoginValidationFailure;

export function normalizeLoginInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  return trimmed;
}

export function validateLoginCredentials(login: string, password: string): LoginValidationResult {
  const trimmedLogin = login.trim();
  const trimmedPassword = password.trim();

  if (!trimmedLogin) {
    return {
      ok: false,
      field: 'login',
      code: 'LOGIN_REQUIRED',
      message: 'Email or username is required',
    };
  }

  if (trimmedLogin.length < LOGIN_MIN_LENGTH) {
    return {
      ok: false,
      field: 'login',
      code: 'LOGIN_TOO_SHORT',
      message: `Login must be at least ${LOGIN_MIN_LENGTH} characters`,
    };
  }

  if (trimmedLogin.length > LOGIN_MAX_LENGTH) {
    return {
      ok: false,
      field: 'login',
      code: 'LOGIN_TOO_LONG',
      message: `Login must be at most ${LOGIN_MAX_LENGTH} characters`,
    };
  }

  if (trimmedLogin.includes('@') && !EMAIL_RE.test(trimmedLogin)) {
    return {
      ok: false,
      field: 'login',
      code: 'INVALID_EMAIL',
      message: 'Enter a valid email address',
    };
  }

  if (!password) {
    return {
      ok: false,
      field: 'password',
      code: 'PASSWORD_REQUIRED',
      message: 'Password is required',
    };
  }

  if (trimmedPassword.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      field: 'password',
      code: 'PASSWORD_TOO_SHORT',
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    };
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      field: 'password',
      code: 'PASSWORD_TOO_LONG',
      message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    };
  }

  return {
    ok: true,
    login: normalizeLoginInput(trimmedLogin),
    password,
  };
}
