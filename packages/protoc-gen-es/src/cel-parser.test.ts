// Copyright 2021-2025 Buf Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { test, describe } from "node:test";
import assert from "node:assert";
import { parseCELExpression } from "./cel-parser.js";

describe("CEL Parser", () => {
  describe("parseCELExpression", () => {
    test("parses empty string", () => {
      const result = parseCELExpression("");
      assert.deepStrictEqual(result, {
        readOnlyFields: [],
        unsupportedFields: [],
        errors: [],
        nestedConstraints: {},
        unionGroups: [],
      });
    });

    test("parses whitespace only", () => {
      const result = parseCELExpression("   ");
      assert.deepStrictEqual(result, {
        readOnlyFields: [],
        unsupportedFields: [],
        errors: [],
        nestedConstraints: {},
        unionGroups: [],
      });
    });

    // Basic empty value patterns
    test("parses this.field == '' (empty string)", () => {
      const result = parseCELExpression("this.field == ''");
      assert.deepStrictEqual(result.readOnlyFields, ["field"]);
      assert.deepStrictEqual(result.errors, []);
    });

    test("parses this.field == 0 (int zero)", () => {
      const result = parseCELExpression("this.field == 0");
      assert.deepStrictEqual(result.readOnlyFields, ["field"]);
      assert.deepStrictEqual(result.errors, []);
    });

    test("parses this.field == 0.0 (float zero)", () => {
      const result = parseCELExpression("this.field == 0.0");
      assert.deepStrictEqual(result.readOnlyFields, ["field"]);
      assert.deepStrictEqual(result.errors, []);
    });

    test("parses this.field == 0u (uint64 zero)", () => {
      const result = parseCELExpression("this.field == 0u");
      assert.deepStrictEqual(result.readOnlyFields, ["field"]);
      assert.deepStrictEqual(result.errors, []);
    });

    test("parses this.field == false", () => {
      const result = parseCELExpression("this.field == false");
      assert.deepStrictEqual(result.readOnlyFields, ["field"]);
      assert.deepStrictEqual(result.errors, []);
    });

    // has() negation patterns
    test("parses !has(this.field)", () => {
      const result = parseCELExpression("!has(this.field)");
      assert.deepStrictEqual(result.readOnlyFields, ["field"]);
      assert.deepStrictEqual(result.errors, []);
    });

    test("parses !this.field (optimized form)", () => {
      const result = parseCELExpression("!this.field");
      assert.deepStrictEqual(result.readOnlyFields, ["field"]);
      assert.deepStrictEqual(result.errors, []);
    });

    // Field naming
    test("converts snake_case to camelCase", () => {
      const result = parseCELExpression("this.field_name == ''");
      assert.deepStrictEqual(result.readOnlyFields, ["fieldName"]);
      assert.deepStrictEqual(result.errors, []);
    });

    // Logical operators
    test("parses multiple constraints with &&", () => {
      const result = parseCELExpression(
        "this.field1 == '' && this.field2 == 0",
      );
      assert.deepStrictEqual(result.readOnlyFields, ["field1", "field2"]);
      assert.deepStrictEqual(result.errors, []);
    });

    test("creates union groups for || constraints", () => {
      const result = parseCELExpression(
        "this.field1 == '' || this.field2 == 0",
      );
      // Fields in OR are not in readOnlyFields (that's for && only)
      assert.deepStrictEqual(result.readOnlyFields, []);
      assert.deepStrictEqual(result.nestedConstraints, {});
      // Instead, they create union groups
      assert.deepStrictEqual(result.unionGroups, [
        { readOnlyFields: ["field1"], nestedConstraints: {} },
        { readOnlyFields: ["field2"], nestedConstraints: {} },
      ]);
      assert.deepStrictEqual(result.errors, []);
    });

    test("handles mixed && and || operators", () => {
      const result = parseCELExpression(
        "this.field1 == '' && (this.field2 == 0 || this.field3 == false)",
      );
      // field1 is in pure && context, so it's read-only
      assert.deepStrictEqual(result.readOnlyFields, ["field1"]);
      // field2 and field3 are in OR, so they create union groups
      assert.deepStrictEqual(result.unionGroups, [
        { readOnlyFields: ["field2"], nestedConstraints: {} },
        { readOnlyFields: ["field3"], nestedConstraints: {} },
      ]);
      assert.deepStrictEqual(result.errors, []);
    });

    test("combines !has with && correctly", () => {
      const result = parseCELExpression(
        "!has(this.field1) && this.field2 == ''",
      );
      assert.deepStrictEqual(result.readOnlyFields, ["field1", "field2"]);
      assert.deepStrictEqual(result.errors, []);
    });

    // Union groups (OR constraints)
    test("creates union groups for nested fields with ||", () => {
      const result = parseCELExpression(
        "this.parent.child1 == '' || this.parent.child2 == 0",
      );
      assert.deepStrictEqual(result.readOnlyFields, []);
      assert.deepStrictEqual(result.nestedConstraints, {});
      // Each branch of OR creates a separate union group
      assert.deepStrictEqual(result.unionGroups, [
        { readOnlyFields: [], nestedConstraints: { parent: ["child1"] } },
        { readOnlyFields: [], nestedConstraints: { parent: ["child2"] } },
      ]);
      assert.deepStrictEqual(result.errors, []);
    });

    test("handles complex OR with multiple parents", () => {
      const result = parseCELExpression(
        "this.parent1.field == '' || this.parent2.field == 0",
      );
      assert.deepStrictEqual(result.unionGroups, [
        { readOnlyFields: [], nestedConstraints: { parent1: ["field"] } },
        { readOnlyFields: [], nestedConstraints: { parent2: ["field"] } },
      ]);
      assert.deepStrictEqual(result.errors, []);
    });

    test("handles OR with mix of top-level and nested fields", () => {
      const result = parseCELExpression(
        "this.topLevel == '' || this.parent.nested == 0",
      );
      assert.deepStrictEqual(result.unionGroups, [
        { readOnlyFields: ["topLevel"], nestedConstraints: {} },
        { readOnlyFields: [], nestedConstraints: { parent: ["nested"] } },
      ]);
      assert.deepStrictEqual(result.errors, []);
    });

    test("handles multiple OR branches", () => {
      const result = parseCELExpression(
        "this.field1 == '' || this.field2 == 0 || this.field3 == false",
      );
      // All three fields should be in separate union groups
      assert.deepStrictEqual(result.unionGroups.length, 3);
      assert.deepStrictEqual(result.unionGroups, [
        { readOnlyFields: ["field1"], nestedConstraints: {} },
        { readOnlyFields: ["field2"], nestedConstraints: {} },
        { readOnlyFields: ["field3"], nestedConstraints: {} },
      ]);
      assert.deepStrictEqual(result.errors, []);
    });

    // Nested fields
    test("parses nested field this.parent.child == ''", () => {
      const result = parseCELExpression("this.parent.child == ''");
      assert.deepStrictEqual(result.readOnlyFields, []);
      assert.deepStrictEqual(result.nestedConstraints, { parent: ["child"] });
      assert.deepStrictEqual(result.errors, []);
    });

    test("parses deep nested field (extracts only first two levels)", () => {
      const result = parseCELExpression("this.parent.child.grandchild == ''");
      assert.deepStrictEqual(result.readOnlyFields, []);
      // Only parent.child is tracked due to TypeScript type system limitations
      assert.deepStrictEqual(result.nestedConstraints, { parent: ["child"] });
      assert.deepStrictEqual(result.errors, []);
    });

    test("handles multiple nested constraints", () => {
      const result = parseCELExpression(
        "this.parent1.child1 == '' && this.parent2.child2 == 0",
      );
      assert.deepStrictEqual(result.readOnlyFields, []);
      assert.deepStrictEqual(result.nestedConstraints, {
        parent1: ["child1"],
        parent2: ["child2"],
      });
      assert.deepStrictEqual(result.errors, []);
    });

    test("converts nested snake_case to camelCase", () => {
      const result = parseCELExpression("this.parent_field.child_field == ''");
      assert.deepStrictEqual(result.readOnlyFields, []);
      assert.deepStrictEqual(result.nestedConstraints, {
        parentField: ["childField"],
      });
      assert.deepStrictEqual(result.errors, []);
    });

    // Deduplication
    test("removes duplicate top-level fields", () => {
      const result = parseCELExpression("this.field == '' && this.field == 0");
      assert.deepStrictEqual(result.readOnlyFields, ["field"]);
      assert.deepStrictEqual(result.errors, []);
    });

    test("handles duplicate nested constraints", () => {
      const result = parseCELExpression(
        "this.parent.child == '' && this.parent.child == 0",
      );
      assert.deepStrictEqual(result.readOnlyFields, []);
      // Duplicates should be removed
      assert.deepStrictEqual(result.nestedConstraints, {
        parent: ["child"],
      });
      assert.deepStrictEqual(result.errors, []);
    });

    // Non-empty value comparisons (should be ignored)
    test("ignores non-empty string comparison", () => {
      const result = parseCELExpression("this.field == 'value'");
      assert.deepStrictEqual(result.readOnlyFields, []);
      assert.deepStrictEqual(result.errors, []);
    });

    test("ignores true value comparison", () => {
      const result = parseCELExpression("this.field == true");
      assert.deepStrictEqual(result.readOnlyFields, []);
      assert.deepStrictEqual(result.errors, []);
    });

    test("ignores null comparison", () => {
      const result = parseCELExpression("this.field == null");
      assert.deepStrictEqual(result.readOnlyFields, []);
      assert.deepStrictEqual(result.errors, []);
    });

    test("ignores non-zero numeric comparison", () => {
      const result = parseCELExpression("this.field == 42");
      assert.deepStrictEqual(result.readOnlyFields, []);
      assert.deepStrictEqual(result.errors, []);
    });

    // Field reference patterns
    test("ignores non-this field references", () => {
      const result = parseCELExpression("field == ''");
      assert.deepStrictEqual(result.readOnlyFields, []);
      assert.deepStrictEqual(result.errors, []);
    });

    // Error handling
    test("handles parse errors gracefully", () => {
      const result = parseCELExpression("invalid expression +++");
      assert(result.errors.length > 0);
      assert(result.errors[0].includes("Failed to parse"));
      assert.deepStrictEqual(result.readOnlyFields, []);
    });

    test("handles invalid field names with parsing error", () => {
      const result = parseCELExpression("this.123invalid == ''");
      assert(result.errors.length > 0);
      // CEL parser catches syntax error before field validation
      assert(result.errors[0].includes("Failed to parse"));
      assert.deepStrictEqual(result.readOnlyFields, []);
    });
  });
});
