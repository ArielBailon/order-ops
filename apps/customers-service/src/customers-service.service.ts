import { Injectable } from '@nestjs/common';

@Injectable()
export class CustomersServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
