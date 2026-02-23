import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

function normalize(value) {
  return String(value ?? "").trim();
}

export async function withPrompter(run) {
  const rl = readline.createInterface({ input, output });

  const api = {
    async text(params) {
      const message = normalize(params?.message);
      const placeholder = normalize(params?.placeholder);
      const initialValue = normalize(params?.initialValue);
      const required = Boolean(params?.required);
      const validate = typeof params?.validate === "function" ? params.validate : null;

      const suffix = [
        placeholder ? ` (${placeholder})` : "",
        initialValue ? ` [default: ${initialValue}]` : "",
      ].join("");

      while (true) {
        let raw;
        try {
          raw = await rl.question(
            `${message}${suffix}: `,
            params?.signal ? { signal: params.signal } : undefined,
          );
        } catch (error) {
          if (error && typeof error === "object" && error.name === "AbortError") {
            throw error;
          }
          throw error;
        }
        const picked = normalize(raw || initialValue);
        if (required && !picked) {
          output.write("Required.\n");
          continue;
        }
        if (validate) {
          const issue = validate(picked);
          if (issue) {
            output.write(`${normalize(issue)}\n`);
            continue;
          }
        }
        return picked;
      }
    },

    async confirm(params) {
      const message = normalize(params?.message);
      const initialValue = params?.initialValue === false ? "n" : "y";
      while (true) {
        const raw = normalize(await rl.question(`${message} (y/n) [${initialValue}]: `));
        const picked = normalize(raw || initialValue).toLowerCase();
        if (picked === "y" || picked === "yes") {
          return true;
        }
        if (picked === "n" || picked === "no") {
          return false;
        }
        output.write("Please answer y or n.\n");
      }
    },

    async select(params) {
      const message = normalize(params?.message);
      const options = Array.isArray(params?.options) ? params.options : [];
      if (options.length === 0) {
        throw new Error("No options available for selection.");
      }
      output.write(`${message}\n`);
      for (let i = 0; i < options.length; i += 1) {
        const opt = options[i];
        const hint = normalize(opt?.hint);
        output.write(`${i + 1}. ${normalize(opt?.label ?? opt?.value)}${hint ? ` - ${hint}` : ""}\n`);
      }
      while (true) {
        const raw = normalize(await rl.question("Select number: "));
        const idx = Number.parseInt(raw, 10);
        if (Number.isNaN(idx) || idx < 1 || idx > options.length) {
          output.write("Invalid selection.\n");
          continue;
        }
        return options[idx - 1]?.value;
      }
    },

    note(text, title) {
      const heading = normalize(title) || "Note";
      const body = normalize(text);
      output.write(`\n[${heading}]\n${body}\n\n`);
    },

    progress(label) {
      const initial = normalize(label);
      if (initial) {
        output.write(`${initial}\n`);
      }
      return {
        update(next) {
          const line = normalize(next);
          if (line) {
            output.write(`${line}\n`);
          }
        },
        stop(doneLabel) {
          const line = normalize(doneLabel);
          if (line) {
            output.write(`${line}\n`);
          }
        },
      };
    },

    intro(text) {
      const line = normalize(text);
      if (line) {
        output.write(`${line}\n`);
      }
    },

    outro(text) {
      const line = normalize(text);
      if (line) {
        output.write(`${line}\n`);
      }
    },
  };

  try {
    return await run(api);
  } finally {
    rl.close();
  }
}
