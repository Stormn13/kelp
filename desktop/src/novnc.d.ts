// Minimal types for noVNC's RFB client, which ships JavaScript only.
// `@novnc/novnc` exports exactly one module: `core/rfb.js`.
declare module "@novnc/novnc" {
  export interface RFBCredentials {
    username?: string;
    password?: string;
  }

  export interface RFBOptions {
    shared?: boolean;
    viewOnly?: boolean;
    scaleViewport?: boolean;
    resizeSession?: boolean;
    clipViewport?: boolean;
    wsProtocols?: string[];
    credentials?: RFBCredentials;
  }

  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    addEventListener(type: string, listener: (event: Event) => void): void;
    removeEventListener(type: string, listener: (event: Event) => void): void;
    disconnect(): void;
    focus(): void;
    sendCredentials(credentials: RFBCredentials): void;
  }
}
