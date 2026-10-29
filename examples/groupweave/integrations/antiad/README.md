# Optional anti-ad inference adapter

The public snapshot keeps the GroupWeave adapter (`worker.py`, `config.py`),
host integration, and dependency pins. It does not include the original private
classifier modules `antiad/scoring.py`, `antiad/model.py`, and
`antiad/textnorm.py`, or a model file. Their public redistribution terms were
not verified, so those modules are omitted and no license or attribution is
claimed for them.

As shipped, anti-ad review is disabled and unavailable. To use this optional
integration, provide your own provenance-reviewed, API-compatible
implementations of the expected `antiad.scoring`, `antiad.model`, and
`antiad.textnorm` modules, along with an administrator-reviewed model. The
modules must be placed in the `integrations/antiad/antiad/` package location;
their APIs must satisfy the imports used by `worker.py`. Review their source,
license, data provenance, and compatibility independently. Nothing from the
original private implementation is included in this case.

The optional `compose.antiad.yaml` override builds the Python runtime and
mounts a model file read-only. It requires an explicit `ANTIAD_MODEL_FILE`
pointing to an operator-managed file. It does not install or supply replacement
classifier modules. Do not enable the override until compatible reviewed
modules and the reviewed model are present. Group members and AI cannot choose
the executable or model path.

After adding the reviewed modules and setting the model path in the private
environment, start the optional native deployment from the repository root:

```sh
docker compose --env-file examples/groupweave/.env.local \
  -f examples/groupweave/compose.yaml \
  -f examples/groupweave/compose.koishi.yaml \
  -f examples/groupweave/compose.antiad.yaml up -d --build
```

## Adapter boundary

The host invokes the fixed `worker.py` process through
`src/server/antiad.ts`. Python and model paths come from trusted deployment
configuration. Startup probes the implementation and loads the model; missing
modules, dependencies, model, or inference fail closed. No fallback scores are
generated.

The host calls `executor(request, signal?)` or
`executor.classify(request, signal?)`. A request contains trusted actor, group,
audience, authorization, text, and a group-rule snapshot. The worker accepts
only text/rules/message fields and does not receive credentials, database
access, executable selection, or arbitrary arguments. Input, output, stderr,
concurrency, timeout, and cancellation are bounded in the adapter. See
[`worker.py`](worker.py) and [`config.py`](antiad/config.py) for the fixed
interface.

Outputs are review suggestions only. They do not call Telegram, mute, delete,
ban, train, read another bot's database, consult CAS, or call an LLM. They grant
no authority to punish a user. This adapter is not the complete moderation
workflow: automatic message detection, join verification, reports, appeals,
human review, and moderation actions remain outside the implemented scope.

## Operator-supplied dependencies

Install `requirements.txt` in the existing application's Python virtual
environment when enabling the optional runtime. Python 3.13 is the validated
target for these dependency pins. A `joblib` model is pickle content and can
execute Python while loading. Only a trusted platform administrator should
provide a reviewed model at a read-only path, and its training-data provenance
and intended sharing should be understood before deployment. Runtime, model
quality, and capacity depend on those supplied components; this repository
does not claim them as verified public artifacts.

For general application startup and Compose usage, see
[`docs/REPOSITORY-SETUP.md`](../../docs/REPOSITORY-SETUP.md). The full historical
acceptance record is not a substitute for verifying operator-supplied modules
and model in their target environment.
