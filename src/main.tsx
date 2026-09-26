import { render } from "preact";

import { startApp } from "./state/app";
import { App } from "./ui/App";
import "./ui/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element.");
render(<App />, root);
startApp();
