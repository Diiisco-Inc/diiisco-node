// Imports
import hasFlag from "has-flag";
import { getArgValue } from "./utils/argv";

// Types
export interface NodeOptions {
  apiAccess: boolean;
  peer: string;
}

// Get Settings Shared to Node
const options: NodeOptions = {
  apiAccess: hasFlag("api-access"),
  peer: getArgValue("peer") ?? "auto",
};

console.log("Node Options:", options);