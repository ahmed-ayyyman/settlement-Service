import { BadRequestException, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ClassConstructor } from 'class-transformer';

export class ParseJsonPayloadPipe<T extends object> implements PipeTransform<
  string,
  Promise<T>
> {
  constructor(private readonly dtoClass: ClassConstructor<T>) {}

  async transform(value: string): Promise<T> {
    if (!value) {
      throw new BadRequestException('JSON payload is required');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(value) as Record<string, unknown>;
    } catch {
      throw new BadRequestException('Invalid JSON payload');
    }

    const dto = plainToInstance(this.dtoClass, parsed);
    const errors = await validate(dto);

    if (errors.length > 0) {
      throw new BadRequestException(errors);
    }

    return dto;
  }
}
