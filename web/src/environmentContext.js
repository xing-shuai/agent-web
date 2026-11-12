import React from "react";
import { environment } from "./api.js";

// The pane's execution environment. Defaults to local so standalone
// component tests need no provider.
export const EnvironmentContext = React.createContext(environment(""));
export const useEnvironment = () => React.useContext(EnvironmentContext);
