export const getArgValue = (arg: string): string | undefined => {
  const index = process.argv.indexOf(`--${arg}`);
  if (index !== -1 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  } else {
    return undefined;
  }
}