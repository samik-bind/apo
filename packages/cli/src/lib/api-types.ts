/** Response of `POST /api-keys/bootstrap` — first key minted at login/setup. */
export type BootstrapResponse = {
  id: string;
  name: string;
  prefix: string;
  project: string;
  created_by: string;
  scope: string;
  created_at: string;
  key: string;
};
