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

/**
 * CEL Expression Parser for buf.validate.message constraints
 *
 * This module parses Common Expression Language (CEL) expressions from
 * buf.validate.message options to extract read-only field constraints
 * and literal type constraints for TypeScript type generation.
 */

import { parse } from "@bufbuild/cel";
import type { Expr } from "@bufbuild/cel-spec/cel/expr/syntax_pb.js";
import { snakeToCamel } from "./util.js";

// ============================================================================
// Types
// ============================================================================

type LiteralValue = string | number | boolean;

interface UnionBranch {
  readOnlyFields: string[];
  literalFields: Record<string, LiteralValue>;
  nestedConstraints: Record<string, string[]>;
}

export interface CELParseResult {
  /** Fields that must be omitted (only from !has() checks) */
  readOnlyFields: string[];
  /** Fields with specific literal value constraints (including '', 0, false) */
  literalFields: Record<string, LiteralValue>;
  /** Fields that couldn't be parsed */
  unsupportedFields: string[];
  /** Parse errors encountered */
  errors: string[];
  /** Nested field constraints (parent -> child fields to omit) */
  nestedConstraints: Record<string, string[]>;
  /** Union branches for OR constraints */
  unionGroups: UnionBranch[];
}

// ============================================================================
// Main Parser Entry Point
// ============================================================================

/**
 * Parse CEL expression to extract field constraints for TypeScript type generation
 *
 * Supports:
 * - Literal checks: `field == 'value'` → field type is literal "value"
 * - Literal checks: `field == ''` → field type is literal "" (empty string)
 * - Literal checks: `field == 0` → field type is literal 0
 * - Literal checks: `field == false` → field type is literal false
 * - Field omission: `!has(field)` → field is omitted from type
 * - AND constraints: both conditions apply
 * - OR constraints: creates union types
 */
export function parseCELExpression(celExpression: string) {
  const result = createEmptyResult();

  if (!celExpression.trim()) {
    return result;
  }

  try {
    const parsedExpr = parse(celExpression);

    if (!parsedExpr.expr) {
      result.errors.push(`No expression found in CEL: ${celExpression}`);
      return result;
    }

    visitExpr(parsedExpr.expr, result);
    deduplicateResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(
      `Failed to parse CEL expression "${celExpression}": ${message}`,
    );
  }

  return result;
}

// ============================================================================
// Expression Visitors
// ============================================================================

function visitExpr(expr: Expr, result: CELParseResult) {
  if (!expr.exprKind?.case || expr.exprKind.case !== "callExpr") {
    return;
  }

  const call = expr.exprKind.value;

  switch (call.function) {
    case "!_":
      handleNegation(call.args[0], result);
      break;
    case "_==_":
      handleEquality(call.args, result);
      break;
    case "_&&_":
      handleAnd(call.args, result);
      break;
    case "_||_":
      handleOr(call.args, result);
      break;
  }
}

// ============================================================================
// Operator Handlers
// ============================================================================

function handleNegation(arg: Expr | undefined, result: CELParseResult) {
  if (!arg?.exprKind) return;

  // Case 1: !has(this.field)
  if (arg.exprKind.case === "callExpr") {
    const innerCall = arg.exprKind.value;
    if (innerCall.function === "has" && innerCall.args.length === 1) {
      const field = extractFieldPath(innerCall.args[0]);
      if (field) {
        addReadOnlyField(field, result);
      }
    }
    return;
  }

  // Case 2: !this.field (optimized form)
  if (arg.exprKind.case === "selectExpr" || arg.exprKind.case === "identExpr") {
    const field = extractFieldPath(arg);
    if (field) {
      addReadOnlyField(field, result);
    }
  }
}

function handleEquality(
  args: readonly (Expr | undefined)[],
  result: CELParseResult,
) {
  if (args.length !== 2) return;

  const [left, right] = args;

  // Try: field == constant
  processEqualityPair(left, right, result);
  // Try: constant == field
  processEqualityPair(right, left, result);
}

function processEqualityPair(
  fieldExpr: Expr | undefined,
  valueExpr: Expr | undefined,
  result: CELParseResult,
) {
  const constantValue = extractConstant(valueExpr);
  if (constantValue === undefined) return;

  const field = extractFieldPath(fieldExpr);
  if (!field) return;

  const isTopLevel = !field.includes(".");

  if (isTopLevel) {
    // All constants generate literal types, including '', 0, false
    result.literalFields[snakeToCamel(field)] = constantValue;
  } else {
    // Nested fields: mark as read-only (omitted)
    addReadOnlyField(field, result);
  }
}

function handleAnd(
  args: readonly (Expr | undefined)[],
  result: CELParseResult,
) {
  // All conditions must be true → accumulate in same result
  for (const arg of args) {
    if (arg) {
      visitExpr(arg, result);
    }
  }
}

function handleOr(args: readonly (Expr | undefined)[], result: CELParseResult) {
  // Create union: each branch is an alternative
  const branches: UnionBranch[] = [];

  for (const arg of args) {
    if (!arg) continue;

    const branchResult = createEmptyResult();
    visitExpr(arg, branchResult);

    if (hasBranchConstraints(branchResult)) {
      branches.push({
        readOnlyFields: branchResult.readOnlyFields,
        literalFields: branchResult.literalFields,
        nestedConstraints: branchResult.nestedConstraints,
      });
    }

    result.errors.push(...branchResult.errors);
  }

  result.unionGroups.push(...branches);
}

// ============================================================================
// Field Extraction
// ============================================================================

function extractFieldPath(expr: Expr | undefined): string | null {
  if (!expr?.exprKind) return null;

  switch (expr.exprKind.case) {
    case "identExpr":
      // Standalone identifiers are not field accesses
      return null;

    case "selectExpr": {
      const select = expr.exprKind.value;
      if (!select.operand) return null;

      const operandPath = extractFieldPath(select.operand);

      // If operand is "this", return just the field name
      if (operandPath === null && isThisIdentifier(select.operand)) {
        return select.field;
      }

      // Build nested path: this.parent.child
      if (operandPath) {
        return `${operandPath}.${select.field}`;
      }

      return null;
    }

    default:
      return null;
  }
}

function isThisIdentifier(expr: Expr) {
  return (
    expr.exprKind?.case === "identExpr" && expr.exprKind.value.name === "this"
  );
}

// ============================================================================
// Value Extraction
// ============================================================================

function extractConstant(expr: Expr | undefined) {
  if (!expr?.exprKind || expr.exprKind.case !== "constExpr") {
    return undefined;
  }

  const constant = expr.exprKind.value;
  if (!constant.constantKind) return undefined;

  switch (constant.constantKind.case) {
    case "stringValue":
      return constant.constantKind.value;
    case "int64Value":
    case "uint64Value":
      return Number(constant.constantKind.value);
    case "doubleValue":
    case "boolValue":
      return constant.constantKind.value;
    default:
      return undefined;
  }
}

// ============================================================================
// Result Manipulation
// ============================================================================

function createEmptyResult(): CELParseResult {
  return {
    readOnlyFields: [],
    literalFields: {},
    unsupportedFields: [],
    errors: [],
    nestedConstraints: {},
    unionGroups: [],
  };
}

function addReadOnlyField(fieldPath: string, result: CELParseResult) {
  if (!fieldPath.includes(".")) {
    // Top-level field
    result.readOnlyFields.push(snakeToCamel(fieldPath));
    return;
  }

  // Nested field: only track first two levels
  const parts = fieldPath.split(".").map(snakeToCamel);
  if (parts.length < 2) return;

  const [parentField, childField] = parts;
  if (!result.nestedConstraints[parentField]) {
    result.nestedConstraints[parentField] = [];
  }
  result.nestedConstraints[parentField].push(childField);
}

function hasBranchConstraints(result: CELParseResult) {
  return (
    result.readOnlyFields.length > 0 ||
    Object.keys(result.literalFields).length > 0 ||
    Object.keys(result.nestedConstraints).length > 0
  );
}

function deduplicateResult(result: CELParseResult) {
  result.readOnlyFields = [...new Set(result.readOnlyFields)];
  result.unsupportedFields = [...new Set(result.unsupportedFields)];

  for (const parent in result.nestedConstraints) {
    result.nestedConstraints[parent] = [
      ...new Set(result.nestedConstraints[parent]),
    ];
  }
}
