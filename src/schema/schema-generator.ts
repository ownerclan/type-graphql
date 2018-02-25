import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLNamedType,
  GraphQLFieldConfigMap,
  GraphQLOutputType,
  GraphQLInputObjectType,
  GraphQLFieldConfigArgumentMap,
  GraphQLInputType,
  GraphQLInputFieldConfigMap,
  GraphQLScalarType,
  GraphQLInterfaceType,
  GraphQLFieldConfig,
  GraphQLInputFieldConfig,
} from "graphql";

import { MetadataStorage } from "../metadata/metadata-storage";
import {
  HandlerDefinition,
  ParamDefinition,
  ClassDefinition,
} from "../metadata/definition-interfaces";
import { TypeOptions, TypeValue } from "../types/decorators";
import { wrapWithTypeOptions, convertTypeIfScalar } from "../types/helpers";
import { createResolver, createFieldResolver } from "../resolvers/create";
import { BuildContext, BuildContextOptions } from "./build-context";

interface TypeInfo {
  target: Function;
  type: GraphQLObjectType;
}
interface InputInfo {
  target: Function;
  type: GraphQLInputObjectType;
}
interface InterfaceInfo {
  target: Function;
  type: GraphQLInterfaceType;
}
// tslint:disable-next-line:no-empty-interface
export interface SchemaGeneratorOptions extends BuildContextOptions {}

export abstract class SchemaGenerator {
  private static typesInfo: TypeInfo[] = [];
  private static inputsInfo: InputInfo[] = [];
  private static interfacesInfo: InterfaceInfo[] = [];

  static generateFromMetadata(options: SchemaGeneratorOptions): GraphQLSchema {
    BuildContext.create(options);
    MetadataStorage.build();
    this.buildTypesInfo();

    const schema = new GraphQLSchema({
      query: this.buildRootQuery(),
      mutation: this.buildRootMutation(),
      types: this.buildTypes(),
    });

    BuildContext.reset();
    return schema;
  }

  private static buildTypesInfo() {
    this.interfacesInfo = MetadataStorage.interfaceTypes.map<InterfaceInfo>(interfaceType => ({
      target: interfaceType.target,
      type: new GraphQLInterfaceType({
        name: interfaceType.name,
        description: interfaceType.description,
        fields: () =>
          interfaceType.fields!.reduce<GraphQLFieldConfigMap<any, any>>((fields, field) => {
            fields[field.name] = {
              description: field.description,
              type: this.getGraphQLOutputType(field.getType(), field.typeOptions),
            };
            return fields;
          }, {}),
      }),
    }));

    this.typesInfo = MetadataStorage.objectTypes.map<TypeInfo>(objectType => {
      const objectSuperClass = Object.getPrototypeOf(objectType.target);
      const hasExtended = objectSuperClass.prototype !== undefined;
      const getSuperClassType = () =>
        this.typesInfo.find(type => type.target === objectSuperClass)!.type;
      const interfaceClasses = objectType.interfaceClasses || [];
      return {
        target: objectType.target,
        type: new GraphQLObjectType({
          name: objectType.name,
          description: objectType.description,
          isTypeOf: instance => {
            if (interfaceClasses.length === 0 && !hasExtended) {
              return true;
            }
            return instance instanceof objectType.target;
          },
          interfaces: () => {
            let interfaces = interfaceClasses.map<GraphQLInterfaceType>(
              interfaceClass =>
                this.interfacesInfo.find(info => info.target === interfaceClass)!.type,
            );
            // copy interfaces from super class
            if (hasExtended) {
              interfaces = Array.from(
                new Set(interfaces.concat(getSuperClassType().getInterfaces())),
              );
            }
            return interfaces;
          },
          fields: () => {
            const fields = objectType.fields!.reduce<GraphQLFieldConfigMap<any, any>>(
              (fieldsMap, field) => {
                const fieldResolverDefinition = MetadataStorage.fieldResolvers.find(
                  resolver =>
                    resolver.getParentType!() === objectType.target &&
                    resolver.methodName === field.name,
                );
                fieldsMap[field.name] = {
                  type: this.getGraphQLOutputType(field.getType(), field.typeOptions),
                  args: this.generateHandlerArgs(field.params!),
                  resolve: fieldResolverDefinition && createFieldResolver(fieldResolverDefinition),
                  description: field.description,
                  deprecationReason: field.deprecationReason,
                };
                return fieldsMap;
              },
              {},
            );
            // support for extending classes - get field info from prototype
            if (hasExtended) {
              Object.assign(fields, this.getFieldDefinitionFromObjectType(getSuperClassType()));
            }
            // support for implicitly implementing interfaces
            // get fields from interfaces definitions
            if (objectType.interfaceClasses) {
              const interfacesFields = objectType.interfaceClasses.reduce<
                GraphQLFieldConfigMap<any, any>
              >((fieldsMap, interfaceClass) => {
                const interfaceType = this.interfacesInfo.find(
                  type => type.target === interfaceClass,
                )!.type;
                return Object.assign(
                  fieldsMap,
                  this.getFieldDefinitionFromObjectType(interfaceType),
                );
              }, {});
              Object.assign(fields, interfacesFields);
            }
            return fields;
          },
        }),
      };
    });

    this.inputsInfo = MetadataStorage.inputTypes.map<InputInfo>(inputType => {
      const objectSuperClass = Object.getPrototypeOf(inputType.target);
      const getSuperClassType = () =>
        this.inputsInfo.find(type => type.target === objectSuperClass)!.type;
      return {
        target: inputType.target,
        type: new GraphQLInputObjectType({
          name: inputType.name,
          description: inputType.description,
          fields: () => {
            const fields = inputType.fields!.reduce<GraphQLInputFieldConfigMap>(
              (fieldsMap, field) => {
                fieldsMap[field.name] = {
                  description: field.description,
                  type: this.getGraphQLInputType(field.getType(), field.typeOptions),
                };
                return fieldsMap;
              },
              {},
            );
            // support for extending classes - get field info from prototype
            if (objectSuperClass.prototype !== undefined) {
              Object.assign(fields, this.getFieldDefinitionFromInputType(getSuperClassType()));
            }
            return fields;
          },
        }),
      };
    });
  }

  private static buildRootQuery(): GraphQLObjectType {
    return new GraphQLObjectType({
      name: "Query",
      fields: this.generateHandlerFields(MetadataStorage.queries),
    });
  }

  private static buildRootMutation(): GraphQLObjectType | undefined {
    if (MetadataStorage.mutations.length > 0) {
      return new GraphQLObjectType({
        name: "Mutation",
        fields: this.generateHandlerFields(MetadataStorage.mutations),
      });
    }
    return undefined;
  }

  private static buildTypes(): GraphQLNamedType[] {
    return [...this.typesInfo.map(it => it.type), ...this.interfacesInfo.map(it => it.type)];
  }

  private static generateHandlerFields<T = any, U = any>(
    handlers: HandlerDefinition[],
  ): GraphQLFieldConfigMap<T, U> {
    return handlers.reduce<GraphQLFieldConfigMap<T, U>>((fields, handler) => {
      fields[handler.methodName] = {
        type: this.getGraphQLOutputType(handler.getReturnType(), handler.returnTypeOptions),
        args: this.generateHandlerArgs(handler.params!),
        resolve: createResolver(handler),
        description: handler.description,
        deprecationReason: handler.deprecationReason,
      };
      return fields;
    }, {});
  }

  private static generateHandlerArgs(params: ParamDefinition[]): GraphQLFieldConfigArgumentMap {
    return params!.reduce<GraphQLFieldConfigArgumentMap>((args, param) => {
      if (param.kind === "arg") {
        args[param.name] = {
          description: param.description,
          type: this.getGraphQLInputType(param.getType(), param.typeOptions),
        };
      } else if (param.kind === "args") {
        const argumentType = MetadataStorage.argumentTypes.find(
          it => it.target === param.getType(),
        )!;
        let superClass = Object.getPrototypeOf(argumentType.target);
        while (superClass.prototype !== undefined) {
          const superArgumentType = MetadataStorage.argumentTypes.find(
            it => it.target === superClass,
          )!;
          this.mapArgFields(superArgumentType, args);
          superClass = Object.getPrototypeOf(superClass);
        }
        this.mapArgFields(argumentType, args);
      }
      return args;
    }, {});
  }

  private static mapArgFields(
    argumentType: ClassDefinition,
    args: GraphQLFieldConfigArgumentMap = {},
  ) {
    argumentType.fields!.forEach(field => {
      args[field.name] = {
        description: field.description,
        type: this.getGraphQLInputType(field.getType(), field.typeOptions),
      };
    });
  }

  private static getFieldDefinitionFromObjectType(type: GraphQLObjectType | GraphQLInterfaceType) {
    const fieldInfo = type.getFields();
    const typeFields = Object.keys(fieldInfo).reduce<GraphQLFieldConfigMap<any, any>>(
      (fieldsMap, fieldName) => {
        const superField = fieldInfo[fieldName];
        fieldsMap[fieldName] = {
          type: superField.type,
          args: superField.args.reduce<GraphQLFieldConfigArgumentMap>(
            (argMap, { name, ...arg }) => {
              argMap[name] = arg;
              return argMap;
            },
            {},
          ),
          resolve: superField.resolve,
          description: superField.description,
          deprecationReason: superField.deprecationReason,
        } as GraphQLFieldConfig<any, any>;
        return fieldsMap;
      },
      {},
    );
    return typeFields;
  }

  private static getFieldDefinitionFromInputType(type: GraphQLInputObjectType) {
    const fieldInfo = type.getFields();
    const typeFields = Object.keys(fieldInfo).reduce<GraphQLInputFieldConfigMap>(
      (fieldsMap, fieldName) => {
        const superField = fieldInfo[fieldName];
        fieldsMap[fieldName] = {
          type: superField.type,
          description: superField.description,
        } as GraphQLInputFieldConfig;
        return fieldsMap;
      },
      {},
    );
    return typeFields;
  }

  private static getGraphQLOutputType(
    type: TypeValue,
    typeOptions: TypeOptions = {},
  ): GraphQLOutputType {
    let gqlType: GraphQLOutputType | undefined;
    gqlType = convertTypeIfScalar(type);
    if (!gqlType) {
      const objectType = this.typesInfo.find(it => it.target === (type as Function));
      if (objectType) {
        gqlType = objectType.type;
      }
    }
    if (!gqlType) {
      const interfaceType = this.interfacesInfo.find(it => it.target === (type as Function));
      if (interfaceType) {
        gqlType = interfaceType.type;
      }
    }
    if (!gqlType) {
      throw new Error(`Cannot determine GraphQL output type for ${type.name}`!);
    }

    return wrapWithTypeOptions(gqlType, typeOptions);
  }

  private static getGraphQLInputType(
    type: TypeValue,
    typeOptions: TypeOptions = {},
  ): GraphQLInputType {
    const gqlType: GraphQLInputType =
      convertTypeIfScalar(type) ||
      this.inputsInfo.find(it => it.target === (type as Function))!.type;

    return wrapWithTypeOptions(gqlType, typeOptions);
  }
}
