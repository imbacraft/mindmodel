package shop;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Voucher {
    @Id
    private Long id;
    private VoucherStatus status;
    private String code;
}
