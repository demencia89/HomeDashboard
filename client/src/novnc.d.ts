declare module '@novnc/novnc' {
  export interface RfbCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RfbOptions {
    credentials?: RfbCredentials;
  }

  export interface RfbDisconnectEvent extends CustomEvent<{ clean: boolean }> {}

  export interface RfbCredentialsRequiredEvent extends CustomEvent<{ types: string[] }> {}

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);

    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;

    disconnect(): void;
    focus(options?: FocusOptions): void;
    sendCtrlAltDel(): void;
    sendCredentials(credentials: RfbCredentials): void;
    addEventListener(type: 'connect', listener: (event: CustomEvent<Record<string, never>>) => void, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: 'disconnect', listener: (event: RfbDisconnectEvent) => void, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: 'credentialsrequired', listener: (event: RfbCredentialsRequiredEvent) => void, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: 'securityfailure', listener: (event: CustomEvent<{ status?: number; reason?: string }>) => void, options?: boolean | AddEventListenerOptions): void;
  }
}
