/* eslint-disable @typescript-eslint/no-explicit-any */
export type ArgumentsType<T extends (...args: any[]) => any> = T extends (...args: infer A) => any
	? A
	: never;
