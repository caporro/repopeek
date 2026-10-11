import { git } from './git';
import type { DeploymentStatus } from '../shared/types';

/** Read the nearest reachable v/V tag and the number of commits since it, without fetching. */
export async function getDeploymentStatus(root: string): Promise<DeploymentStatus> {
  let head: string;
  try {
    head = (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).toString().trim();
  } catch (error) {
    return { state: (error as { code?: number }).code === 1 ? 'unborn' : 'unavailable' };
  }
  try {
    // --always distinguishes an untagged history from an actual Git failure.
    const value = (
      await git(root, ['describe', '--tags', '--match', '[vV]*', '--long', '--always', '--abbrev=40', head])
    )
      .toString()
      .trim();
    const match = /^(.+)-(\d+)-g[a-f0-9]+$/.exec(value);
    if (match && Number.isSafeInteger(Number(match[2])))
      return { state: 'tagged', tag: match[1], ahead: Number(match[2]) };
    return { state: /^[a-f0-9]{40,64}$/.test(value) ? 'untagged' : 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
}
