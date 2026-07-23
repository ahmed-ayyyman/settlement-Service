export class PaginatedResponseDto<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}
