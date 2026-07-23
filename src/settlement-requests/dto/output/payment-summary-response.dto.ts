export class PaymentSummaryMeetingFeeDto {
  meetingId: string;
  fee: number;
}

export class PaymentSummaryResponseDto {
  meetingFees: PaymentSummaryMeetingFeeDto[];
  total: number;
}
