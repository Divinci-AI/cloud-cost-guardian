import React from "react";
import ReactDOM from "react-dom/client";
import { Auth0Provider } from "@auth0/auth0-react";
import { App } from "./App";

const AUTH0_DOMAIN = import.meta.env.VITE_AUTH0_DOMAIN || "divinci-staging.us.auth0.com";
const AUTH0_CLIENT_ID = import.meta.env.VITE_AUTH0_CLIENT_ID || "ZrCGlaJYHv2UbgCCtaV9v8xhae2g46Ui";
const AUTH0_AUDIENCE = import.meta.env.VITE_AUTH0_AUDIENCE || "https://guardian-api.divinci.app";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Auth0Provider
      domain={AUTH0_DOMAIN}
      clientId={AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: AUTH0_AUDIENCE,
      }}
      onRedirectCallback={(appState) => {
        // After Auth0 login, navigate to the page the user was originally trying to reach
        const returnTo = appState?.returnTo || "/";
        window.history.replaceState({}, "", returnTo);
      }}
    >
      <App />
    </Auth0Provider>
  </React.StrictMode>
);
