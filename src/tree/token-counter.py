"""Offline only: pinned official Messages conversion and model-specific encoding."""
import hashlib
import json
import pathlib
import sys
import zipfile

resources = pathlib.Path(__file__).with_name("tokenizer-resources")
manifest = json.loads((resources / "manifest.json").read_text())
for asset in manifest["assets"]:
    if hashlib.sha256((resources / asset["name"]).read_bytes()).hexdigest() != asset["sha256"]:
        raise ValueError("Frozen tokenizer resource changed: " + asset["name"])

modules = pathlib.Path(sys.argv[2]).resolve()
wheel = next(resources.glob("*.whl"))
if sys.argv[1] == "initialize":
    modules.mkdir(parents=True, exist_ok=True, mode=0o700)
    with zipfile.ZipFile(wheel) as archive:
        for entry in archive.infolist():
            path = pathlib.PurePosixPath(entry.filename)
            if path.is_absolute() or ".." in path.parts or entry.external_attr >> 16 & 0o170000 == 0o120000:
                raise ValueError("Unsafe frozen wheel member")
        archive.extractall(modules)
    print(json.dumps({"initialized": True}))
else:
    # -I plus an explicit private dependency directory excludes user/site imports.
    sys.path.insert(0, str(modules))
    from deepseek_recipe import MessagesRequest, ConversionOptions, ModelVersion, DeepseekV4Encoding, DeepseekV41Encoding, Tokenizer
    body = json.load(sys.stdin)
    mapping = manifest["modelMappings"].get(body["model"])
    if mapping is None:
        raise ValueError("No frozen tokenizer mapping for this model")
    versions = {"DeepseekV4Pro": ModelVersion.DeepseekV4Pro, "DeepseekV41Flash": ModelVersion.DeepseekV41Flash}
    encodings = {"DeepseekV4Encoding": DeepseekV4Encoding, "DeepseekV41Encoding": DeepseekV41Encoding}
    converted = MessagesRequest(body).convert(ConversionOptions().with_model_alias(body["model"], versions[mapping["modelVersion"]]))
    encoding = encodings[mapping["encoding"]]().with_tokenizer(Tokenizer.from_file(str(resources / mapping["tokenizer"])))
    print(json.dumps({"tokens": len(encoding.encode(converted.conversation))}))
