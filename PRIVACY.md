# Privacy and development data

Pulsar is a local-first, single-user music application. It has no project-operated account system, analytics service, or telemetry backend. Neutralino logging is disabled in the supplied desktop configuration.

## Data handled by the application

- The music library, playback state, editing sessions, and automatic backups remain on the user's device unless the user explicitly enables synchronization or a network feature.
- Optional library synchronization writes music metadata to a destination chosen by the user. Audio files, cover blobs, local paths, and expiring stream URLs are not included in the synchronization manifest.
- Media search/download, lyrics providers, and GitHub update checks make network requests only for their documented features. These requests go directly to the relevant third-party service; there is no Pulsar-operated relay.
- Optional AI lyrics alignment runs locally after explicit setup. The track audio and supplied lyrics are not sent to an AI service. Network access is used to install the requested packages and download the model.
- Optional Google sign-in stores OAuth state in the application's private local storage. Development must not use real tokens, client secrets, or personal Drive contents.

## Repository and development rules

- Use synthetic audio, lyrics, library records, provider responses, and placeholder credentials in tests.
- Do not commit passwords, API keys, OAuth secrets/tokens, private signing keys, personal libraries, or other people's personal data.
- Do not add real user files to bug fixtures. Reduce reports to anonymous or synthetic examples first.
- Existing browser and unit tests are designed to run offline with mocks/stubs; real accounts and paid services are not required.

This document describes the project's data boundaries; third-party services have their own privacy policies.
