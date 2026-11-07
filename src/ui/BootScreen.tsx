import { APP_NAME, BAY_CALLSIGN } from '../brand';

/** Shown while the arm model loads (and if it cannot). */
export function BootScreen({ error }: { error?: string }) {
  return (
    <div className="boot" role={error ? 'alert' : 'status'}>
      <div className="boot-card">
        <span className="boot-name">{APP_NAME}</span>
        {error ? (
          <>
            <p>The bay could not start: {error}</p>
            <button type="button" className="btn primary" onClick={() => location.reload()}>
              Try again
            </button>
          </>
        ) : (
          <p>
            Docking with {BAY_CALLSIGN}
            <span className="boot-dots" aria-hidden="true" />
          </p>
        )}
      </div>
    </div>
  );
}
