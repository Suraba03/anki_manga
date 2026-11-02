# Writes extension/test/fixtures/add.onnx: one Add node, float32[1] inputs a,b -> output c.
# Run: uv run --no-project --with onnx python -I tools/make-add-onnx.py
import onnx
from onnx import TensorProto, helper

vi = lambda n: helper.make_tensor_value_info(n, TensorProto.FLOAT, [1])
graph = helper.make_graph([helper.make_node("Add", ["a", "b"], ["c"])], "add", [vi("a"), vi("b")], [vi("c")])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], ir_version=8)
onnx.checker.check_model(model)
onnx.save(model, "extension/test/fixtures/add.onnx")
