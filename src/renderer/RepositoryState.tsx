import type { DeploymentStatus } from '../shared/types';
import { Icon } from './ui';

export function RepositoryState({ deployment, dirty }: { deployment: DeploymentStatus; dirty: boolean }) {
  const base =
    deployment.state === 'tagged'
      ? deployment.ahead === 0
        ? `Allineato al tag ${deployment.tag}`
        : `${deployment.ahead} commit dopo il tag ${deployment.tag}`
      : deployment.state === 'unborn'
        ? 'Nessun commit'
        : deployment.state === 'untagged'
          ? 'Nessun tag v* nel branch'
          : 'Stato del tag non disponibile';
  const description = `${base}${dirty ? ' · +1 commit da fare: modifiche locali non committate' : ''}`;
  return (
    <div className="repo-state-indicator" role="img" aria-label={description} title={description}>
      {deployment.state === 'tagged' ? (
        deployment.ahead === 0 ? (
          !dirty && (
            <span className="repo-state-aligned" aria-hidden="true">
              <Icon name="check" size={40} />
            </span>
          )
        ) : (
          <span className="repo-state-ahead" aria-hidden="true">
            {deployment.ahead}
          </span>
        )
      ) : (
        <span className="repo-state-unknown" aria-hidden="true">
          —
        </span>
      )}
      {dirty && (
        <span className="repo-state-pending" aria-hidden="true">
          +1
        </span>
      )}
    </div>
  );
}
