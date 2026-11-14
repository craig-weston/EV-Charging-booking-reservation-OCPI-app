// The public map's icons: one 24px stroke set, drawn in currentColor (the CSS adds the neon glow).
// TRUCK and BOLT are also drawn onto the map's pins (see pinImage in PublicMap.tsx).
import type { ReactNode } from "react";

export const BOLT = "M13.2 2 4.5 13.6h6.1L9.8 22l8.7-11.6h-6.1z";

const Svg = ({ children, size = 18, fill }: { children: ReactNode; size?: number; fill?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="pm-ico">{children}</svg>
);

export const IconBolt = ({ size }: { size?: number }) => <Svg size={size} fill><path d={BOLT} /></Svg>;
/** An artic: tractor unit and trailer. */
export const IconArtic = ({ size }: { size?: number }) => (
  <Svg size={size}><path d="M1.5 6.5h12v9h-12z" /><path d="M13.5 9.5h4.2l3.3 3.4v2.6h-7.5" /><circle cx="5" cy="17.3" r="1.7" /><circle cx="9" cy="17.3" r="1.7" /><circle cx="17.5" cy="17.3" r="1.7" /></Svg>
);
/** A rigid: one body, cab at the front. */
export const IconRigid = ({ size }: { size?: number }) => (
  <Svg size={size}><path d="M3 6.5h10v9H3z" /><path d="M13 9.5h3.8l3.2 3.4v2.6H13" /><circle cx="6.5" cy="17.3" r="1.7" /><circle cx="16.8" cy="17.3" r="1.7" /></Svg>
);
export const IconPlug = ({ size }: { size?: number }) => <Svg size={size}><path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0z" /><path d="M12 16v5" /></Svg>;
export const IconMegawatt = ({ size }: { size?: number }) => <Svg size={size}><circle cx="12" cy="12" r="9" /><path d="M12.8 6.5 8.5 12.6h3.4l-.7 4.9 4.3-6.1h-3.4z" fill="currentColor" stroke="none" /></Svg>;
export const IconBay = ({ size }: { size?: number }) => <Svg size={size}><path d="M4 3v18M20 3v18" /><path d="M9 8h6v8H9z" /><path d="M12 3v2M12 19v2" strokeDasharray="1 2.5" /></Svg>;
export const IconHeight = ({ size }: { size?: number }) => <Svg size={size}><path d="M3 4h18" /><path d="M12 7v13M9 10l3-3 3 3M9 17l3 3 3-3" /></Svg>;
export const IconWeight = ({ size }: { size?: number }) => <Svg size={size}><path d="M6.5 8h11l2.5 12H4z" /><circle cx="12" cy="5.5" r="2.2" /></Svg>;
export const IconDriveThrough = ({ size }: { size?: number }) => <Svg size={size}><path d="M5 4v16M19 4v16" /><path d="M8 12h8M13 9l3 3-3 3" /></Svg>;
export const IconClock = ({ size }: { size?: number }) => <Svg size={size}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
export const IconFleet = ({ size }: { size?: number }) => <Svg size={size}><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M16 5.5a3 3 0 0 1 0 5.6M17.5 14a5.5 5.5 0 0 1 3 5" /></Svg>;
export const IconRoute = ({ size }: { size?: number }) => <Svg size={size}><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="5" r="2.2" /><path d="M8.2 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.8" /></Svg>;
export const IconShare = ({ size }: { size?: number }) => <Svg size={size}><path d="M12 3v12M8 7l4-4 4 4" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></Svg>;
export const IconSearch = ({ size }: { size?: number }) => <Svg size={size}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>;
export const IconLocate = ({ size }: { size?: number }) => <Svg size={size}><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></Svg>;
export const IconBack = ({ size }: { size?: number }) => <Svg size={size}><path d="M15 18l-6-6 6-6" /></Svg>;
export const IconPin = ({ size }: { size?: number }) => <Svg size={size}><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></Svg>;
export const IconCheck = ({ size }: { size?: number }) => <Svg size={size}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const IconCross = ({ size }: { size?: number }) => <Svg size={size}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const IconQuestion = ({ size }: { size?: number }) => <Svg size={size}><circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17v.3" /></Svg>;
export const IconCup = ({ size }: { size?: number }) => <Svg size={size}><path d="M4 9h12v4a6 6 0 0 1-12 0z" /><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16" /><path d="M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3" /></Svg>;
export const IconFood = ({ size }: { size?: number }) => <Svg size={size}><path d="M6 3v7a2 2 0 0 0 2 2v9M10 3v7a2 2 0 0 1-2 2M8 3v5" /><path d="M17 21V3c-2 1.5-3 4-3 7h3" /></Svg>;
export const IconBed = ({ size }: { size?: number }) => <Svg size={size}><path d="M3 18V6M3 13h18v5M21 18v-3a3 3 0 0 0-3-3h-7v1" /><circle cx="7" cy="10" r="1.6" /></Svg>;
export const IconFuel = ({ size }: { size?: number }) => <Svg size={size}><path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M6 9h6" /><path d="M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8l-3-3" /></Svg>;
export const IconWifi = ({ size }: { size?: number }) => <Svg size={size}><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0" /><circle cx="12" cy="19.2" r="0.9" fill="currentColor" /></Svg>;
export const IconParking = ({ size }: { size?: number }) => <Svg size={size}><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M9.5 17V7h3.5a3 3 0 0 1 0 6H9.5" /></Svg>;
export const IconBasket = ({ size }: { size?: number }) => <Svg size={size}><path d="M3 9h18l-2 11H5z" /><path d="M8 9l3-6M16 9l-3-6M9 13v4M15 13v4" /></Svg>;
