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

import type {
  DescEnum,
  DescField,
  DescFile,
  DescMessage,
  DescOneof,
  DescService,
} from "@bufbuild/protobuf";
import { getOption } from "@bufbuild/protobuf";
import { embedFileDesc, pathInFileDesc } from "@bufbuild/protobuf/codegenv2";
import { parentTypes } from "@bufbuild/protobuf/reflect";
import { isWrapperDesc } from "@bufbuild/protobuf/wkt";
import {
  type GeneratedFile,
  type Printable,
  type Schema,
  type Target,
  createEcmaScriptPlugin,
} from "@bufbuild/protoplugin";
import { version } from "../package.json";
import { parseCELExpression } from "./cel-parser.js";
import { message as ext_message } from "./gen/minimal-validate_pb.js";
import {
  fieldJsonType,
  fieldTypeScriptType,
  functionCall,
  messageGenType,
} from "./util.js";
import { snakeToCamel } from "./util.js";
import {
  isLegacyRequired,
  isProtovalidateDisabled,
  isProtovalidateRequired,
  messageNeedsCustomValidType,
} from "./valid-types.js";

/**
 * Returns true if the message has buf.validate.message options with CEL expressions
 */
export function messageHasBufValidateOptions(message: DescMessage): boolean {
  if (!ext_message) {
    return false;
  }
  return getOption(message, ext_message) !== undefined;
}

/**
 * Extracts read-only field names from buf.validate.message CEL expressions
 */
export function getReadOnlyFields(message: DescMessage): string[] {
  try {
    const messageRules = getOption(message, ext_message);
    if (!messageRules?.cel || messageRules.cel.length === 0) {
      return [];
    }

    // Combine all CEL expressions from the constraints
    const allReadOnlyFields: string[] = [];
    for (const constraint of messageRules.cel) {
      if (constraint.expression) {
        const result = parseCELExpression(constraint.expression);
        allReadOnlyFields.push(...result.readOnlyFields);
      }
    }

    // Remove duplicates and convert snake_case to camelCase
    const uniqueFields = [...new Set(allReadOnlyFields)];
    return uniqueFields.map((field) => {
      // Convert snake_case to camelCase for TypeScript field names
      return field.includes(".") ? field : snakeToCamel(field);
    });
  } catch {
    // If there's any error parsing, return empty array to avoid breaking generation
    return [];
  }
}

/**
 * Extracts union groups from buf.validate.message CEL expressions
 *
 * @param message - The message descriptor to analyze
 * @returns Array of union groups, each containing read-only fields and nested constraints
 */
function getUnionGroups(message: DescMessage): Array<{
  readOnlyFields: string[];
  nestedConstraints: Record<string, string[]>;
}> {
  try {
    const messageRules = getOption(message, ext_message);
    if (!messageRules?.cel || messageRules.cel.length === 0) {
      return [];
    }

    const allUnionGroups: Array<{
      readOnlyFields: string[];
      nestedConstraints: Record<string, string[]>;
    }> = [];

    for (const constraint of messageRules.cel) {
      if (constraint.expression) {
        const result = parseCELExpression(constraint.expression);

        // Add all union groups from this constraint
        allUnionGroups.push(...result.unionGroups);
      }
    }

    return allUnionGroups;
  } catch {
    // If there's any error parsing, return empty array to avoid breaking generation
    return [];
  }
}

/**
 * Extracts nested read-only field constraints from buf.validate.message CEL expressions
 *
 * @param message - The message descriptor to analyze
 * @returns Record mapping parent field names to arrays of child field names to omit
 */
function getNestedReadOnlyFields(
  message: DescMessage,
): Record<string, string[]> {
  try {
    const messageRules = getOption(message, ext_message);
    if (!messageRules?.cel || messageRules.cel.length === 0) {
      return {};
    }

    // Combine all nested constraints from all CEL expressions
    const allNestedConstraints: Record<string, string[]> = {};

    for (const constraint of messageRules.cel) {
      if (constraint.expression) {
        const result = parseCELExpression(constraint.expression);

        // Merge nested constraints
        for (const [key, fields] of Object.entries(result.nestedConstraints)) {
          if (!allNestedConstraints[key]) {
            allNestedConstraints[key] = [];
          }
          allNestedConstraints[key].push(...fields);
        }
      }
    }

    // Remove duplicates from each nested constraint array
    for (const key of Object.keys(allNestedConstraints)) {
      allNestedConstraints[key] = [...new Set(allNestedConstraints[key])];
    }

    return allNestedConstraints;
  } catch {
    // If there's any error parsing, return empty object to avoid breaking generation
    return {};
  }
}

export const protocGenEs = createEcmaScriptPlugin({
  name: "protoc-gen-es",
  version: `v${String(version)}`,
  parseOptions,
  generateTs,
  generateJs,
  generateDts,
});

type Options = {
  jsonTypes: boolean;
  validTypes: {
    legacyRequired: boolean;
    protovalidateRequired: boolean;
  };
  celValidation: boolean;
};

function parseOptions(
  options: {
    key: string;
    value: string;
  }[],
): Options {
  let jsonTypes = false;
  let validTypes = {
    legacyRequired: false,
    protovalidateRequired: false,
  };
  let celValidation = false;
  for (const { key, value } of options) {
    switch (key) {
      case "json_types":
        if (!["true", "1", "false", "0"].includes(value)) {
          throw "please provide true or false";
        }
        jsonTypes = ["true", "1"].includes(value);
        break;
      case "valid_types":
        for (const part of value.split("+")) {
          switch (part) {
            case "protovalidate_required":
              validTypes.protovalidateRequired = true;
              break;
            case "legacy_required":
              validTypes.legacyRequired = true;
              break;
            default:
              throw new Error();
          }
        }
        break;
      case "cel_validation":
        if (!["true", "1", "false", "0"].includes(value)) {
          throw "please provide true or false";
        }
        celValidation = ["true", "1"].includes(value);
        break;
      default:
        throw new Error();
    }
  }
  return { jsonTypes, validTypes, celValidation };
}

// This annotation informs bundlers that the succeeding function call is free of
// side effects. This means the symbol can be removed from the module during
// tree-shaking if it is unused.
// See https://github.com/bufbuild/protobuf-es/pull/470
const pure = "/*@__PURE__*/";

// biome-ignore format: want this to read well
function generateTs(schema: Schema<Options>) {
  for (const file of schema.files) {
    const f = schema.generateFile(file.name + "_pb.ts");
    f.preamble(file);
    const { GenFile } = f.runtime.codegen;
    const fileDesc = f.importSchema(file);
    generateDescDoc(f, file);
    f.print(f.export("const", fileDesc.name), ": ", GenFile, " = ", pure);
    f.print("  ", getFileDescCall(f, file, schema), ";");
    f.print();
    for (const desc of schema.typesInFile(file)) {
      switch (desc.kind) {
        case "message": {
          generateMessageShape(f, desc, "ts");
          if (schema.options.jsonTypes) {
            generateMessageJsonShape(f, desc, "ts");
          }
          if (
            schema.options.validTypes.legacyRequired ||
            schema.options.validTypes.protovalidateRequired
          ) {
            generateMessageValidShape(f, desc, schema.options.validTypes, "ts");
          }
          generateDescDoc(f, desc);
          const name = f.importSchema(desc).name;
          f.print(
            f.export("const", name),
            ": ",
            messageGenType(desc, f, schema.options),
            " = ",
            pure
          );
          const call = functionCall(f.runtime.codegen.messageDesc, [
            fileDesc,
            ...pathInFileDesc(desc),
          ]);
          f.print("  ", call, ";");
          f.print();
          break;
        }
        case "enum": {
          generateEnumShape(f, desc);
          if (schema.options.jsonTypes) {
            generateEnumJsonShape(f, desc, "ts");
          }
          generateDescDoc(f, desc);
          const name = f.importSchema(desc).name;
          const Shape = f.importShape(desc);
          const { GenEnum, enumDesc } = f.runtime.codegen;
          if (schema.options.jsonTypes) {
            const JsonType = f.importJson(desc);
            f.print(
              f.export("const", name),
              ": ",
              GenEnum,
              "<",
              Shape,
              ", ",
              JsonType,
              ">",
              " = ",
              pure
            );
          } else {
            f.print(
              f.export("const", name),
              ": ",
              GenEnum,
              "<",
              Shape,
              ">",
              " = ",
              pure
            );
          }
          const call = functionCall(enumDesc, [
            fileDesc,
            ...pathInFileDesc(desc),
          ]);
          f.print("  ", call, ";");
          f.print();
          break;
        }
        case "extension": {
          const { GenExtension, extDesc } = f.runtime.codegen;
          const name = f.importSchema(desc).name;
          const E = f.importShape(desc.extendee);
          const V = fieldTypeScriptType(desc, f.runtime).typing;
          const call = functionCall(extDesc, [
            fileDesc,
            ...pathInFileDesc(desc),
          ]);
          f.print(f.jsDoc(desc));
          f.print(
            f.export("const", name),
            ": ",
            GenExtension,
            "<",
            E,
            ", ",
            V,
            ">",
            " = ",
            pure
          );
          f.print("  ", call, ";");
          f.print();
          break;
        }
        case "service": {
          const { GenService, serviceDesc } = f.runtime.codegen;
          const name = f.importSchema(desc).name;
          const call = functionCall(serviceDesc, [
            fileDesc,
            ...pathInFileDesc(desc),
          ]);
          f.print(f.jsDoc(desc));
          f.print(
            f.export("const", name),
            ": ",
            GenService,
            "<",
            getServiceShapeExpr(f, desc),
            "> = ",
            pure
          );
          f.print("  ", call, ";");
          f.print();
          break;
        }
      }
    }
  }
}

// biome-ignore format: want this to read well
function generateJs(schema: Schema<Options>) {
  for (const file of schema.files) {
    const f = schema.generateFile(file.name + "_pb.js");
    f.preamble(file);
    const fileDesc = f.importSchema(file);
    generateDescDoc(f, file);
    f.print(f.export("const", fileDesc.name), " = ", pure);
    f.print("  ", getFileDescCall(f, file, schema), ";");
    f.print();
    for (const desc of schema.typesInFile(file)) {
      switch (desc.kind) {
        case "message": {
          const name = f.importSchema(desc).name;
          generateDescDoc(f, desc);
          const { messageDesc } = f.runtime.codegen;
          const call = functionCall(messageDesc, [
            fileDesc,
            ...pathInFileDesc(desc),
          ]);
          f.print(f.export("const", name), " = ", pure);
          f.print("  ", call, ";");
          f.print();
          break;
        }
        case "enum": {
          // generate descriptor
          {
            generateDescDoc(f, desc);
            const name = f.importSchema(desc).name;
            f.print(f.export("const", name), " = ", pure);
            const { enumDesc } = f.runtime.codegen;
            const call = functionCall(enumDesc, [
              fileDesc,
              ...pathInFileDesc(desc),
            ]);
            f.print("  ", call, ";");
            f.print();
          }
          // declare TypeScript enum
          {
            f.print(f.jsDoc(desc));
            f.print(f.export("const", f.importShape(desc).name), " = ", pure);
            const { tsEnum } = f.runtime.codegen;
            const call = functionCall(tsEnum, [f.importSchema(desc)]);
            f.print("  ", call, ";");
            f.print();
          }
          break;
        }
        case "extension": {
          f.print(f.jsDoc(desc));
          const name = f.importSchema(desc).name;
          f.print(f.export("const", name), " = ", pure);
          const { extDesc } = f.runtime.codegen;
          const call = functionCall(extDesc, [
            fileDesc,
            ...pathInFileDesc(desc),
          ]);
          f.print("  ", call, ";");
          f.print();
          break;
        }
        case "service": {
          f.print(f.jsDoc(desc));
          const name = f.importSchema(desc).name;
          f.print(f.export("const", name), " = ", pure);
          const { serviceDesc } = f.runtime.codegen;
          const call = functionCall(serviceDesc, [
            fileDesc,
            ...pathInFileDesc(desc),
          ]);
          f.print("  ", call, ";");
          f.print();
          break;
        }
      }
    }
  }
}

// biome-ignore format: want this to read well
function generateDts(schema: Schema<Options>) {
  for (const file of schema.files) {
    const f = schema.generateFile(file.name + "_pb.d.ts");
    f.preamble(file);
    const { GenFile } = f.runtime.codegen;
    const fileDesc = f.importSchema(file);
    generateDescDoc(f, file);
    f.print(f.export("declare const", fileDesc.name), ": ", GenFile, ";");
    f.print();
    for (const desc of schema.typesInFile(file)) {
      switch (desc.kind) {
        case "message": {
          generateMessageShape(f, desc, "dts");
          if (schema.options.jsonTypes) {
            generateMessageJsonShape(f, desc, "dts");
          }
          if (
            schema.options.validTypes.legacyRequired ||
            schema.options.validTypes.protovalidateRequired
          ) {
            generateMessageValidShape(
              f,
              desc,
              schema.options.validTypes,
              "dts"
            );
          }
          const name = f.importSchema(desc).name;
          generateDescDoc(f, desc);
          f.print(
            f.export("declare const", name),
            ": ",
            messageGenType(desc, f, schema.options),
            ";"
          );
          f.print();
          break;
        }
        case "enum": {
          generateEnumShape(f, desc);
          if (schema.options.jsonTypes) {
            generateEnumJsonShape(f, desc, "dts");
          }
          generateDescDoc(f, desc);
          const name = f.importSchema(desc).name;
          const Shape = f.importShape(desc);
          const { GenEnum } = f.runtime.codegen;
          if (schema.options.jsonTypes) {
            const JsonType = f.importJson(desc);
            f.print(
              f.export("declare const", name),
              ": ",
              GenEnum,
              "<",
              Shape,
              ", ",
              JsonType,
              ">;"
            );
          } else {
            f.print(
              f.export("declare const", name),
              ": ",
              GenEnum,
              "<",
              Shape,
              ">;"
            );
          }
          f.print();
          break;
        }
        case "extension": {
          const { GenExtension } = f.runtime.codegen;
          const name = f.importSchema(desc).name;
          const E = f.importShape(desc.extendee);
          const V = fieldTypeScriptType(desc, f.runtime).typing;
          f.print(f.jsDoc(desc));
          f.print(
            f.export("declare const", name),
            ": ",
            GenExtension,
            "<",
            E,
            ", ",
            V,
            ">;"
          );
          f.print();
          break;
        }
        case "service": {
          const { GenService } = f.runtime.codegen;
          const name = f.importSchema(desc).name;
          f.print(f.jsDoc(desc));
          f.print(
            f.export("declare const", name),
            ": ",
            GenService,
            "<",
            getServiceShapeExpr(f, desc),
            ">;"
          );
          f.print();
          break;
        }
      }
    }
  }
}

function generateDescDoc(
  f: GeneratedFile,
  desc: DescFile | DescMessage | DescEnum,
): void {
  let lines: string[];
  switch (desc.kind) {
    case "file":
      lines = [`Describes the ${desc.toString()}.`];
      break;
    case "message":
      lines = [
        `Describes the ${desc.toString()}.`,
        `Use \`create(${f.importSchema(desc).name})\` to create a new message.`,
      ];
      break;
    case "enum":
      lines = [`Describes the ${desc.toString()}.`];
      break;
  }
  const deprecated =
    desc.deprecated || parentTypes(desc).some((d) => d.deprecated);
  if (deprecated) {
    lines.push("@deprecated");
  }
  f.print({
    kind: "es_jsdoc",
    text: lines.join("\n"),
  });
}

// biome-ignore format: want this to read well
function getFileDescCall(f: GeneratedFile, file: DescFile, schema: Schema) {
  // Schema provides files with source retention options. Since we do not want to
  // embed source retention options in generated code, we use FileDescriptorProto
  // messages from CodeGeneratorRequest.proto_file instead.
  const sourceFile = file.proto;
  const runtimeFile = schema.proto.protoFile.find(
    (f) => f.name == sourceFile.name
  );
  const info = embedFileDesc(runtimeFile ?? sourceFile);
  if (
    info.bootable &&
    !f.runtime.create.from.startsWith("@bufbuild/protobuf")
  ) {
    // google/protobuf/descriptor.proto is embedded as a plain object when
    // bootstrapping to avoid recursion
    return functionCall(f.runtime.codegen.boot, [JSON.stringify(info.boot())]);
  }
  const { fileDesc } = f.runtime.codegen;
  if (file.dependencies.length > 0) {
    const deps: Printable = file.dependencies.map((f) => ({
      kind: "es_desc_ref",
      desc: f,
    }));
    return functionCall(fileDesc, [f.string(info.base64()), f.array(deps)]);
  }
  return functionCall(fileDesc, [f.string(info.base64())]);
}

// biome-ignore format: want this to read well
function getServiceShapeExpr(
  f: GeneratedFile,
  service: DescService
): Printable {
  const p: Printable[] = ["{\n"];
  for (const method of service.methods) {
    p.push(f.jsDoc(method, "  "), "\n");
    p.push("  ", method.localName, ": {\n");
    p.push("    methodKind: ", f.string(method.methodKind), ";\n");
    p.push("    input: typeof ", f.importSchema(method.input, true), ";\n");
    p.push("    output: typeof ", f.importSchema(method.output, true), ";\n");
    p.push("  },\n");
  }
  p.push("}");
  return p;
}

// biome-ignore format: want this to read well
function generateEnumShape(f: GeneratedFile, enumeration: DescEnum) {
  f.print(f.jsDoc(enumeration));
  f.print(f.export("enum", f.importShape(enumeration).name), " {");
  for (const value of enumeration.values) {
    if (enumeration.values.indexOf(value) > 0) {
      f.print();
    }
    f.print(f.jsDoc(value, "  "));
    f.print("  ", value.localName, " = ", value.number, ",");
  }
  f.print("}");
  f.print();
}

// biome-ignore format: want this to read well
function generateEnumJsonShape(
  f: GeneratedFile,
  enumeration: DescEnum,
  target: Extract<Target, "ts" | "dts">
) {
  f.print(f.jsDoc(enumeration));
  const declaration = target == "ts" ? "type" : "declare type";
  const values: Printable[] = [];
  if (enumeration.typeName == "google.protobuf.NullValue") {
    values.push("null");
  } else {
    for (const v of enumeration.values) {
      if (enumeration.values.indexOf(v) > 0) {
        values.push(" | ");
      }
      values.push(f.string(v.name));
    }
  }
  f.print(
    f.export(declaration, f.importJson(enumeration).name),
    " = ",
    values,
    ";"
  );
  f.print();
}

// biome-ignore format: want this to read well
function generateMessageShape(
  f: GeneratedFile,
  message: DescMessage,
  target: Extract<Target, "ts" | "dts">
) {
  const { Message } = f.runtime;
  const declaration = target == "ts" ? "type" : "declare type";
  f.print(f.jsDoc(message));

  const nestedConstraints = getNestedReadOnlyFields(message);
  const readOnlyFields = getReadOnlyFields(message);
  const unionGroups = getUnionGroups(message);

  // If there are union groups, generate a union type
  if (unionGroups.length > 0) {
    f.print(f.export(declaration, f.importShape(message).name), " = ");

    // Generate each union branch
    for (let i = 0; i < unionGroups.length; i++) {
      const group = unionGroups[i];
      if (i > 0) {
        f.print(" | ");
      }

      // Create a type that omits fields from this union group
      // Note: readOnlyFields are already omitted from all branches,
      // and group.readOnlyFields are omitted from this specific branch

      // Merge nested constraints
      const mergedNestedConstraints = { ...nestedConstraints };
      for (const [key, fields] of Object.entries(group.nestedConstraints)) {
        if (!mergedNestedConstraints[key]) {
          mergedNestedConstraints[key] = [];
        }
        mergedNestedConstraints[key].push(...fields);
        mergedNestedConstraints[key] = [
          ...new Set(mergedNestedConstraints[key]),
        ];
      }

      f.print(Message, "<", f.string(message.typeName), "> & {");

      for (const member of message.members) {
        // Skip members that are in the readOnlyFields list or in this union group's readOnlyFields
        if (
          member.kind === "field" &&
          (readOnlyFields.includes(member.localName) ||
            group.readOnlyFields.includes(member.localName))
        ) {
          continue;
        }
        generateMessageShapeMember(
          f,
          member,
          undefined,
          mergedNestedConstraints
        );
        if (message.members.indexOf(member) < message.members.length - 1) {
          f.print();
        }
      }
      f.print("}");
    }
  } else {
    // Standard case without union groups
    f.print(
      f.export(declaration, f.importShape(message).name),
      " = ",
      Message,
      "<",
      f.string(message.typeName),
      "> & {"
    );

    for (const member of message.members) {
      // Skip members that are in the readOnlyFields list
      if (
        member.kind === "field" &&
        readOnlyFields.includes(member.localName)
      ) {
        continue;
      }
      generateMessageShapeMember(f, member, undefined, nestedConstraints);
      if (message.members.indexOf(member) < message.members.length - 1) {
        f.print();
      }
    }
    f.print("}");
  }
  f.print();
}

// biome-ignore format: want this to read well
function generateMessageValidShape(
  f: GeneratedFile,
  message: DescMessage,
  validTypes: Options["validTypes"],
  target: Extract<Target, "ts" | "dts">
) {
  const declaration = target == "ts" ? "type" : "declare type";
  if (
    !messageNeedsCustomValidType(message, validTypes) &&
    !messageHasBufValidateOptions(message)
  ) {
    f.print(
      f.export(declaration, f.importValid(message).name),
      " = ",
      f.importShape(message),
      ";"
    );
    f.print();
    return;
  }

  const { Message } = f.runtime;
  f.print(f.jsDoc(message));

  const nestedConstraints = getNestedReadOnlyFields(message);
  const readOnlyFields = getReadOnlyFields(message);
  const unionGroups = getUnionGroups(message);

  // If there are union groups, generate a union type
  if (unionGroups.length > 0) {
    f.print(f.export(declaration, f.importValid(message).name), " = ");

    // Generate each union branch
    for (let i = 0; i < unionGroups.length; i++) {
      const group = unionGroups[i];
      if (i > 0) {
        f.print(" | ");
      }

      // Merge nested constraints
      const mergedNestedConstraints = { ...nestedConstraints };
      for (const [key, fields] of Object.entries(group.nestedConstraints)) {
        if (!mergedNestedConstraints[key]) {
          mergedNestedConstraints[key] = [];
        }
        mergedNestedConstraints[key].push(...fields);
        mergedNestedConstraints[key] = [
          ...new Set(mergedNestedConstraints[key]),
        ];
      }

      f.print(Message, "<", f.string(message.typeName), "> & {");

      for (const member of message.members) {
        // Skip members that are in the readOnlyFields list or in this union group's readOnlyFields
        if (
          member.kind === "field" &&
          (readOnlyFields.includes(member.localName) ||
            group.readOnlyFields.includes(member.localName))
        ) {
          continue;
        }
        generateMessageShapeMember(
          f,
          member,
          validTypes,
          mergedNestedConstraints
        );
        if (message.members.indexOf(member) < message.members.length - 1) {
          f.print();
        }
      }
      f.print("}");
    }
  } else {
    // Standard case without union groups
    f.print(
      f.export(declaration, f.importValid(message).name),
      " = ",
      Message,
      "<",
      f.string(message.typeName),
      "> & {"
    );

    for (const member of message.members) {
      // Skip members that are in the readOnlyFields list
      if (
        member.kind === "field" &&
        readOnlyFields.includes(member.localName)
      ) {
        continue;
      }
      generateMessageShapeMember(f, member, validTypes, nestedConstraints);
      if (message.members.indexOf(member) < message.members.length - 1) {
        f.print();
      }
    }
    f.print("}");
  }
  f.print();
}

// biome-ignore format: want this to read well
function generateMessageShapeMember(
  f: GeneratedFile,
  member: DescField | DescOneof,
  validTypes?: Options["validTypes"],
  nestedConstraints?: Record<string, string[]>
) {
  switch (member.kind) {
    case "oneof":
      f.print(f.jsDoc(member, "  "));
      f.print("  ", member.localName, ": {");
      for (const field of member.fields) {
        if (member.fields.indexOf(field) > 0) {
          f.print(`  } | {`);
        }
        f.print(f.jsDoc(field, "    "));
        const { typing } = fieldTypeScriptType(
          field,
          f.runtime,
          validTypes && !isProtovalidateDisabled(field)
        );
        f.print(`    value: `, typing, `;`);
        f.print(`    case: "`, field.localName, `";`);
      }
      f.print(`  } | { case: undefined; value?: undefined };`);
      break;
    case "field":
      f.print(f.jsDoc(member, "  "));
      let { typing, optional } = fieldTypeScriptType(
        member,
        f.runtime,
        validTypes && !isProtovalidateDisabled(member)
      );
      if (optional && validTypes) {
        const isRequired =
          (validTypes.legacyRequired && isLegacyRequired(member)) ||
          (validTypes.protovalidateRequired && isProtovalidateRequired(member));
        if (isRequired) {
          optional = false;
        }
      }

      // Apply nested constraints
      const fieldName = member.localName;
      typing = applyNestedConstraints(typing, fieldName, nestedConstraints);

      if (optional) {
        f.print("  ", member.localName, "?: ", typing, ";");
      } else {
        f.print("  ", member.localName, ": ", typing, ";");
      }
      break;
  }
}

/**
 * Apply nested constraints to a field's type
 *
 * Wraps the field type with Omit<> to exclude child fields that have constraints
 */
function applyNestedConstraints(
  typing: Printable,
  fieldName: string,
  nestedConstraints: Record<string, string[]> | undefined,
): Printable {
  if (!nestedConstraints) {
    return typing;
  }

  const constraintsForField = nestedConstraints[fieldName];
  if (constraintsForField?.length) {
    // Apply Omit for nested fields
    typing = ["Omit<", typing, ", '", constraintsForField.join("' | '"), "'>"];
  }

  return typing;
}

// biome-ignore format: want this to read well
function generateMessageJsonShape(
  f: GeneratedFile,
  message: DescMessage,
  target: Extract<Target, "ts" | "dts">
) {
  const exp = f.export(
    target == "ts" ? "type" : "declare type",
    f.importJson(message).name
  );
  f.print(f.jsDoc(message));
  switch (message.typeName) {
    case "google.protobuf.Any":
      f.print(exp, " = {");
      f.print(`  "@type"?: string;`);
      f.print("};");
      break;
    case "google.protobuf.Timestamp":
      f.print(exp, " = string;");
      break;
    case "google.protobuf.Duration":
      f.print(exp, " = string;");
      break;
    case "google.protobuf.FieldMask":
      f.print(exp, " = string;");
      break;
    case "google.protobuf.Struct":
      f.print(exp, " = ", f.runtime.JsonObject, ";");
      break;
    case "google.protobuf.Value":
      f.print(exp, " = ", f.runtime.JsonValue, ";");
      break;
    case "google.protobuf.ListValue":
      f.print(exp, " = ", f.runtime.JsonValue, "[];");
      break;
    case "google.protobuf.Empty":
      f.print(exp, " = Record<string, never>;");
      break;
    default:
      if (isWrapperDesc(message)) {
        f.print(exp, " = ", fieldJsonType(message.fields[0]), ";");
      } else {
        f.print(exp, " = {");
        for (const field of message.fields) {
          f.print(f.jsDoc(field, "  "));
          let jsonName: Printable = field.jsonName;
          const startWithNumber = /^[0-9]/;
          const containsSpecialChar = /[^a-zA-Z0-9_$]/;
          if (
            jsonName === "" ||
            startWithNumber.test(jsonName) ||
            containsSpecialChar.test(jsonName)
          ) {
            jsonName = f.string(jsonName);
          }
          f.print("  ", jsonName, "?: ", fieldJsonType(field), ";");
          if (message.fields.indexOf(field) < message.fields.length - 1) {
            f.print();
          }
        }
        f.print("};");
      }
  }
  f.print();
}
