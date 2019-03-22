import { validate as cval, ValidatorOptions, ValidationError } from "class-validator";

import { ArgumentValidationError } from "../errors/ArgumentValidationError";

export async function validateArg<T extends Object>(
  arg: T | undefined,
  globalValidate: boolean | ValidatorOptions,
  argValidate?: boolean | ValidatorOptions,
): Promise<T | undefined> {
  const validate = argValidate !== undefined ? argValidate : globalValidate;
  if (validate === false || arg == null || typeof arg !== "object") {
    return arg;
  }

  const validatorOptions: ValidatorOptions = Object.assign(
    {},
    typeof globalValidate === "object" ? globalValidate : {},
    typeof argValidate === "object" ? argValidate : {},
  );
  if (validatorOptions.skipMissingProperties !== false) {
    validatorOptions.skipMissingProperties = true;
  }

  if (customValidateOrRejct) {
    await customValidateOrRejct(arg, validatorOptions);
    return arg;
  }

  const { validateOrReject } = await import("class-validator");
  try {
    await validateOrReject(arg, validatorOptions);
    return arg;
  } catch (err) {
    throw new ArgumentValidationError(err);
  }
}

async function customValidateOrRejct<T extends Object>(
  arg: T | { validate: (opts?: ValidatorOptions) => Promise<ValidationError[]> },
  opts?: ValidatorOptions,
) {
  const errors = await cval(arg, opts);
  if ("validate" in arg) {
    errors.push(...(await arg.validate(opts)));
  }
  if (errors.length > 0) {
    throw new CustomValidationError("Input validation failed.", errors);
  }
}

export class CustomValidationError extends Error {
  validationErrors: ValidationError[];

  constructor(message: string, validationErrors: ValidationError[]) {
    super(message);
    this.validationErrors = validationErrors;
  }
}
