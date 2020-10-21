import * as humanInterval from 'human-interval';
import { isValidHumanInterval } from './nextRunAt';

export function calculateProcessEvery(input?: number | string): number {
	let result = 5000;

	if (typeof input === 'number') {
		result = input;
	}

	if (isValidHumanInterval(input)) {
		result = humanInterval(input) as number;
	}

	return result;
}
