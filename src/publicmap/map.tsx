// Entry for the public charging map (/map). Built next to the app by scripts/build.mjs.
import { createRoot } from "react-dom/client";
import "../styles/app.css";
import "./publicmap.css";
import { PublicMap } from "./PublicMap";

createRoot(document.getElementById("root")!).render(<PublicMap />);
