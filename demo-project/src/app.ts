import clsx from "clsx";
import { z } from "zod";
import chalk from "chalk";

export const className = clsx("foo", { bar: true });
export const schema = z.object({ name: z.string(), age: z.number().optional() });
export const label = chalk.red("error");
