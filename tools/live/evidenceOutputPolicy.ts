import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function containsCanonicalPath(root: string, path: string): boolean {
  const back = relative(root, path);
  return back === '' || (back !== '..' && !back.startsWith(`..${sep}`) && !isAbsolute(back));
}

export async function resolveThroughExistingAncestor(path: string): Promise<string> {
  let ancestor = resolve(path);
  const missingParts: string[] = [];
  while (!(await exists(ancestor))) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot resolve evidence output path: ${path}`);
    missingParts.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(await realpath(ancestor), ...missingParts);
}

export async function assertEvidenceOutputPlacement(
  options: Readonly<{
    repositoryRoot: string;
    outputPath: string;
    label: string;
    allowedRepositoryRoots: readonly string[];
    protectedPaths: readonly string[];
  }>,
): Promise<string> {
  const repositoryLexical = resolve(options.repositoryRoot);
  const repositoryCanonical = await realpath(repositoryLexical);
  const outputLexical = resolve(options.outputPath);
  const outputCanonical = await resolveThroughExistingAncestor(outputLexical);
  const lexicalInsideRepository = containsCanonicalPath(repositoryLexical, outputLexical);

  if (lexicalInsideRepository) {
    let allowed = false;
    for (const configuredRoot of options.allowedRepositoryRoots) {
      const allowedLexical = resolve(repositoryLexical, configuredRoot);
      if (!containsCanonicalPath(allowedLexical, outputLexical)) continue;
      const allowedCanonical = await resolveThroughExistingAncestor(allowedLexical);
      if (
        !containsCanonicalPath(repositoryCanonical, allowedCanonical) ||
        !containsCanonicalPath(allowedCanonical, outputCanonical)
      ) {
        throw new Error(`${options.label} cannot traverse a symbolic-link or junction boundary.`);
      }
      allowed = true;
      break;
    }
    if (!allowed) {
      throw new Error(
        `${options.label} must remain outside repository inputs or inside its dedicated evidence root.`,
      );
    }
  } else if (
    containsCanonicalPath(repositoryCanonical, outputCanonical) ||
    containsCanonicalPath(outputCanonical, repositoryCanonical)
  ) {
    throw new Error(`${options.label} cannot alias or contain the repository.`);
  }

  for (const protectedPath of options.protectedPaths) {
    const protectedCanonical = await resolveThroughExistingAncestor(resolve(protectedPath));
    if (
      containsCanonicalPath(protectedCanonical, outputCanonical) ||
      containsCanonicalPath(outputCanonical, protectedCanonical)
    ) {
      throw new Error(`${options.label} overlaps a protected source or build input.`);
    }
  }
  return outputCanonical;
}
