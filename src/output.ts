/** Bound model-visible text without retaining private responses on disk. */
export function truncateOutput(value: string) {
	const maxBytes = 50 * 1024;
	const maxLines = 2000;
	let outputBytes = 0;
	let outputLines = 1;
	let end = 0;
	for (const character of value) {
		const bytes = Buffer.byteLength(character);
		if (outputBytes + bytes > maxBytes || (character === "\n" && outputLines >= maxLines)) break;
		outputBytes += bytes;
		if (character === "\n") outputLines++;
		end += character.length;
	}
	return { content: value.slice(0, end), truncated: end < value.length, outputBytes, outputLines };
}
