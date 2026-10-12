import type { FormEvent } from "react";

/**
 * Submit handler that hands the form's data to `fn` without React 19's form-action reset, so a form
 * that comes back with an error keeps what the user typed.
 */
export function onSubmitWith(fn: (form: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    fn(new FormData(event.currentTarget));
  };
}
