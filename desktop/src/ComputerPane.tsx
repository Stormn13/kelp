import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";

import {
  DEFAULT_VIEWER_URL,
  normaliseViewerUrl,
  readStoredViewerUrl,
  reconnectDelay,
  statusLabel,
  writeStoredViewerUrl,
  type ViewerStatus,
} from "./computerViewer";

/** The slice of noVNC's RFB this component drives. */
interface ViewerHandle {
  disconnect(): void;
}

interface Session {
  url: string;
  /** Bumped to force a fresh connection on retry. */
  nonce: number;
}

/**
 * The Computer tab: a view-only noVNC viewer onto the VM's graphical session.
 *
 * View-only is deliberate (and `shared` matters too): the agent holds the same
 * session, so this window must never steal the pointer or take the session away
 * from it. There are no keyboard or pointer listeners here at all.
 */
export default function ComputerPane() {
  const [urlInput, setUrlInput] = useState(() => readStoredViewerUrl() ?? DEFAULT_VIEWER_URL);
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<ViewerStatus>("idle");
  const [detail, setDetail] = useState<string | null>(null);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const attemptRef = useRef(0);
  const stoppedRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!session || !host) return;

    let disposed = false;
    let ended = false;
    let viewer: ViewerHandle | null = null;
    let retryTimer = 0;

    setStatus("connecting");
    setDetail(null);

    void (async () => {
      try {
        const { default: RFB } = await import("@novnc/novnc");
        if (disposed) return;

        const rfb = new RFB(host, session.url, {
          // View-only, and `shared` matters just as much: the agent holds this
          // same session, so we must neither send input nor take it away.
          viewOnly: true,
          shared: true,
          scaleViewport: true,
          resizeSession: false,
        });
        viewer = rfb;

        rfb.addEventListener("connect", () => {
          if (disposed) return;
          attemptRef.current = 0;
          setStatus("connected");
          setDetail(null);
        });

        rfb.addEventListener("disconnect", (event: Event) => {
          ended = true;
          if (disposed || stoppedRef.current) return;
          const clean = (event as CustomEvent<{ clean?: boolean }>).detail?.clean;
          setStatus("disconnected");
          setDetail(clean ? "The session ended." : "The connection dropped.");
          attemptRef.current += 1;
          retryTimer = window.setTimeout(() => {
            setSession((current) =>
              current ? { url: current.url, nonce: current.nonce + 1 } : current,
            );
          }, reconnectDelay(attemptRef.current));
        });

        rfb.addEventListener("securityfailure", () => {
          if (disposed) return;
          setStatus("error");
          setDetail("The VNC server rejected this viewer.");
        });

        rfb.addEventListener("credentialsrequired", () => {
          if (disposed) return;
          setStatus("error");
          setDetail("This session needs a password, which this build does not send.");
        });
      } catch (error) {
        if (disposed) return;
        setStatus("error");
        setDetail(error instanceof Error ? error.message : "Could not start the viewer.");
      }
    })();

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      // `disconnect()` on an already-dead RFB logs an error in noVNC, so only
      // close a session that is still up.
      if (!ended) {
        try {
          viewer?.disconnect();
        } catch {
          /* already gone */
        }
      }
      // Drop the last painted frame so a dead session never looks live.
      host.replaceChildren();
    };
  }, [session]);

  const connect = useCallback(() => {
    const normalised = normaliseViewerUrl(urlInput);
    if (!normalised) {
      setStatus("error");
      setDetail("That does not look like a WebSocket viewer URL.");
      return;
    }
    stoppedRef.current = false;
    attemptRef.current = 0;
    setUrlInput(normalised);
    writeStoredViewerUrl(normalised);
    setSession((current) => ({
      url: normalised,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  }, [urlInput]);

  const disconnect = useCallback(() => {
    stoppedRef.current = true;
    setSession(null);
    setStatus("idle");
    setDetail(null);
    hostRef.current?.replaceChildren();
  }, []);

  const connected = status === "connected";

  return (
    <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ px: 3, py: 1.5, borderBottom: "1px solid rgba(25,24,23,0.08)" }}
      >
        <TextField
          size="small"
          label="Viewer URL"
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") connect();
          }}
          placeholder={DEFAULT_VIEWER_URL}
          sx={{ flex: 1, maxWidth: 560 }}
        />
        <Button
          variant="contained"
          size="small"
          onClick={connect}
          disabled={status === "connecting"}
        >
          Connect
        </Button>
        <Button size="small" color="inherit" onClick={disconnect} disabled={!session}>
          Disconnect
        </Button>
        <Chip size="small" variant="outlined" label={connected ? "live · view-only" : "view-only"} />
      </Stack>

      <Box sx={{ position: "relative", flex: 1, minHeight: 0, background: "#141615" }}>
        <Box
          ref={hostRef}
          sx={{
            position: "absolute",
            inset: 0,
            "& canvas": { width: "100% !important", height: "100% !important" },
          }}
        />

        {!connected && (
          <Stack
            sx={{
              position: "absolute",
              inset: 0,
              alignItems: "center",
              justifyContent: "center",
              gap: 1.5,
              px: 3,
              textAlign: "center",
              color: "rgba(255,255,255,0.86)",
            }}
          >
            {status === "connecting" ? (
              <>
                <CircularProgress size={22} sx={{ color: "rgba(255,255,255,0.7)" }} />
                <Typography variant="body2">{statusLabel(status)}</Typography>
              </>
            ) : (
              <>
                <Typography variant="body2">{statusLabel(status)}</Typography>
                {detail && (
                  <Typography variant="caption" sx={{ color: "rgba(255,255,255,0.6)" }}>
                    {detail}
                  </Typography>
                )}
                {status === "idle" && (
                  <Typography variant="caption" sx={{ color: "rgba(255,255,255,0.6)" }}>
                    Point this at a websockify endpoint — local test session or your
                    tunnel — then press Connect.
                  </Typography>
                )}
                {status === "disconnected" && (
                  <Typography variant="caption" sx={{ color: "rgba(255,255,255,0.6)" }}>
                    Reconnecting automatically…
                  </Typography>
                )}
                <Button
                  size="small"
                  startIcon={<ReplayRoundedIcon />}
                  onClick={connect}
                  sx={{ color: "inherit" }}
                >
                  Try again
                </Button>
              </>
            )}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
