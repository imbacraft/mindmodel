package shop;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class VoucherController {
    private final VoucherService service;

    public VoucherController(VoucherService service) {
        this.service = service;
    }

    @PutMapping("/vouchers/{id}/publish")
    public void publish(@PathVariable Long id) {
        service.publish(id);
    }
}
