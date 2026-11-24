package shop;

import org.springframework.stereotype.Service;

@Service
public class LegacyContractService implements ContractPort {
    public void publish(Long voucherId) {
        log(voucherId);
    }

    private void log(Long voucherId) {
    }
}
